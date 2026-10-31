import { isTaskDone } from '@corral/core'
import type { AuditEntry, Epic, Project, Run, Task } from '@corral/contracts'
import { useQueries, useQuery } from '@tanstack/vue-query'
import type { ComputedRef } from 'vue'
import { inboxQuery } from '~/queries/inbox'
import { runsQuery } from '~/queries/runs'
import { taskHistoryQuery } from '~/queries/tasks'
import { epicTitle, epicWithLiveCounts } from '~/utils/labels'
import { completedAt } from '~/utils/completion'
import { projectNeedsYou } from '~/utils/projects'

interface OverviewSource {
  slug: ComputedRef<string>
  project: ComputedRef<Project | null>
  tasks: ComputedRef<Task[]>
  epics: ComputedRef<Epic[]>
  loading: ComputedRef<boolean>
  error: ComputedRef<string | null>
  open: () => boolean
}

// Project overview data (design/project-overview.md), shared by the web page
// and MobileProjectOverview. The project parent route holds its observers, so
// going back to Overview shows it at once. They load once for the project, stay
// live while open, and catch up on return only if something changed in between.
export function useProjectOverview({ slug, project, tasks, epics: epicList, loading, error: listError, open }: OverviewSource) {
  const shell = useShell()
  // The shell keeps the Inbox current, so mounting here never asks again
  const inboxState = useQuery({ ...inboxQuery(), refetchOnMount: false })

  // Preload once to keep the first Overview visit free of requests and an
  // empty-activity flash. After that an event only marks these stale while
  // another tab is open, and opening Overview fetches what it marked.
  const ready = computed(() => Boolean(project.value) && !loading.value)
  const preloaded = ref(false)
  const held = computed(() => ({ staleTime: Infinity, enabled: ready.value && (open() || !preloaded.value) }))
  // Recent activity: the newest audit entries of this project's tasks
  const recent = shallowRef<Task[]>([])
  watch([tasks, ready, open, preloaded], () => {
    if (ready.value && (open() || !preloaded.value)) {
      recent.value = [...tasks.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
    }
  }, { immediate: true })
  const activeRuns = useQuery(computed(() => ({ ...runsQuery({ active: true }), ...held.value })))
  const taskHistories = useQueries({
    queries: computed(() => recent.value.map(task => ({ ...taskHistoryQuery({ slug: slug.value, number: task.number, ref: task.ref }), ...held.value })))
  })
  const taskRuns = useQueries({
    queries: computed(() => recent.value.map(task => ({ ...runsQuery({ taskId: task.id }), ...held.value })))
  })
  watch(() => ready.value && !activeRuns.isPending.value && [...taskHistories.value, ...taskRuns.value].every(query => !query.isPending), (settled) => {
    if (settled) preloaded.value = true
  }, { immediate: true })

  const inbox = computed(() => inboxState.data.value ?? null)
  const runs = computed(() => (activeRuns.data.value ?? []).filter(run => run.projectId === project.value?.id))
  const history = computed(() => taskHistories.value.flatMap(query => query.data ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12))
  // The agent of each run behind the recent activity, by run id
  const runAgents = computed(() => new Map([...taskRuns.value.flatMap(query => query.data ?? []), ...runs.value].map(run => [run.id, run.agentName])))
  // A failed background refetch keeps its data and shows no error
  const failed = computed(() => [inboxState, activeRuns].flatMap(query => query.data.value === undefined && query.error.value ? [query] : []))
  const failedActivity = computed(() => [...taskHistories.value, ...taskRuns.value].filter(query => query.data === undefined && query.error))
  const error = computed(() => listError.value ?? failed.value[0]?.error.value?.message ?? failedActivity.value[0]?.error?.message ?? null)
  async function load() {
    await Promise.all([...failed.value, ...failedActivity.value].map(query => query.refetch()))
  }

  const DOT = { neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-error', success: 'bg-success', secondary: 'bg-secondary' } as const
  const count = (status: Task['status']) => tasks.value.filter(t => t.status === status).length
  const needsYou = computed(() => projectNeedsYou(inbox.value, project.value?.id))
  const weekAgo = Date.now() - 7 * 86_400_000
  const mergedThisWeek = computed(() => tasks.value.filter((t) => {
    const at = completedAt(t)
    return isTaskDone(t) && at !== null && new Date(at).getTime() > weekAgo
  }))
  const firstPass = computed(() => {
    const merged = tasks.value.filter(t => t.status === 'merged')
    if (merged.length === 0) return null
    return Math.round(100 * merged.filter(t => t.reviewRounds === 0).length / merged.length)
  })
  const waitingOnDependency = computed(() => tasks.value.filter(t => t.status === 'ready' && (t.waitingOnEpics.length > 0 || t.dependsOn.some(ref => !tasks.value.some(x => x.ref === ref && isTaskDone(x))))).length)
  // The agents of the active runs, e.g. "Atlas working" or "Atlas and Bolt
  // reviewing"; tasks aren't assigned ahead of time (D15)
  const activeAgents = (role: 'developer' | 'reviewer') => {
    const names = [...new Set(runs.value.filter(r => r.role === role).map(r => r.agentName))]
    return names.length === 0 ? null : names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  }
  const developer = computed(() => activeAgents('developer'))
  const reviewer = computed(() => activeAgents('reviewer'))
  const pmName = computed(() => shell.agents.find(a => a.role === 'pm')?.name ?? 'the PM')
  const epics = computed(() => {
    const groups = new Map<string, { id: string, title: string, merged: number, total: number, epic?: Epic }>()
    const list = epicList.value
    for (const task of tasks.value) {
      const id = task.epicId ?? 'none'
      const found = list.find(e => e.id === id)
      const group = groups.get(id) ?? { id, title: id === 'none' ? 'No epic' : epicTitle(list, id, groups.size), merged: 0, total: 0, epic: found && epicWithLiveCounts(found, tasks.value) }
      group.total++
      if (isTaskDone(task)) group.merged++
      groups.set(id, group)
    }
    return [...groups.values()]
  })
  const taskOf = (run: Run) => tasks.value.find(t => t.id === run.taskId)
  const actorName = (entry: AuditEntry) => entry.actor.kind === 'human' ? 'You' : entry.actor.kind === 'agent' ? (entry.actor.role === 'pm' ? shell.agents.find(a => a.role === 'pm')?.name ?? 'PM' : runAgents.value.get(entry.actor.runId) ?? (entry.actor.role === 'developer' ? 'Developer' : entry.actor.role === 'designer' ? 'Designer' : 'Reviewer')) : 'Corral'
  const taskRefOf = (entry: AuditEntry) => tasks.value.find(t => t.id === entry.taskId)?.ref ?? ''
  const activityText = (entry: AuditEntry) => {
    const d = entry.detail
    if (entry.action === 'task.transition') return `${String(d.from).replaceAll('_', ' ')} → ${String(d.to).replaceAll('_', ' ')}`
    if (entry.action === 'review.recorded') return String(d.verdict).replaceAll('_', ' ')
    if (entry.action === 'task.claimed') return 'claimed'
    if (entry.action === 'run.ended') return `run ended ${String(d.state)}`
    return entry.action.replace('task.', '').replaceAll('.', ' ')
  }

  return { project, tasks, inbox, runs, history, error, load, DOT, count, needsYou, mergedThisWeek, firstPass, waitingOnDependency, developer, reviewer, pmName, epics, taskOf, actorName, taskRefOf, activityText }
}

export type ProjectOverview = ReturnType<typeof useProjectOverview>
