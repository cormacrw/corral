import { isTaskDone } from '@corral/core'
import type { AuditEntry, Epic, Inbox, Project, Run, Task } from '@corral/contracts'
import type { ComputedRef } from 'vue'
import { api } from '~/composables/useApi'
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
// and MobileProjectOverview. The project parent route holds it, so going back
// to Overview shows it at once. It loads once for the project, stays live while
// open, and catches up on return only if something changed in between.
export function useProjectOverview({ slug, project, tasks, epics: epicList, loading, error: listError, open }: OverviewSource) {
  const live = useLive()
  const inbox = ref<Inbox | null>(null)
  const runs = ref<Run[]>([])
  const history = ref<AuditEntry[]>([])
  // The agent of each run behind the recent activity, by run id
  const runAgents = ref<Map<string, string>>(new Map())
  const detailError = ref<string | null>(null)
  const error = computed(() => listError.value ?? detailError.value)

  let loaded = false
  let outdated = false
  let generation = 0
  onBeforeUnmount(() => generation++)
  async function load() {
    if (!project.value || loading.value) return
    const current = ++generation
    const projectId = project.value.id
    const projectSlug = slug.value
    const recent = [...tasks.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
    outdated = false
    loaded = true
    detailError.value = null
    try {
      const [i, r] = await Promise.all([api.inbox.get(), api.runs.list({ active: true })])
      // Recent activity: the newest audit entries of this project's tasks
      const [entries, taskRuns] = await Promise.all([
        Promise.all(recent.map(t => api.tasks.history(projectSlug, t.number))),
        Promise.all(recent.map(t => api.runs.list({ taskId: t.id })))
      ])
      if (current !== generation) return
      inbox.value = i
      runs.value = r.filter(run => run.projectId === projectId)
      history.value = entries.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12)
      runAgents.value = new Map([...taskRuns.flat(), ...r].map(run => [run.id, run.agentName]))
    } catch (e) {
      if (current !== generation) return
      detailError.value = e instanceof Error ? e.message : String(e)
    }
  }
  // Preload once to keep the first Overview visit free of requests and an
  // empty-activity flash. Subsequent changes wait while another tab is open.
  function changed() {
    if (open() || !loaded) void load()
    else outdated = true
  }
  watch([project, tasks, loading], changed, { immediate: true })
  watch(open, (now) => {
    if (now && outdated) void load()
  })
  onMounted(() => {
    const stop = live.subscribe((event) => {
      if (event.type === 'run.updated' && event.run.projectId === project.value?.id) changed()
    })
    onBeforeUnmount(stop)
  })

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
  const pmName = computed(() => live.state.value.agents.find(a => a.role === 'pm')?.name ?? 'the PM')
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
  const actorName = (entry: AuditEntry) => entry.actor.kind === 'human' ? 'You' : entry.actor.kind === 'agent' ? (entry.actor.role === 'pm' ? live.state.value.agents.find(a => a.role === 'pm')?.name ?? 'PM' : runAgents.value.get(entry.actor.runId) ?? (entry.actor.role === 'developer' ? 'Developer' : entry.actor.role === 'designer' ? 'Designer' : 'Reviewer')) : 'Corral'
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
