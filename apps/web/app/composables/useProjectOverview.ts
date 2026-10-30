import type { AuditEntry, Inbox, Run, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { epicTitle } from '~/utils/labels'
import { projectNeedsYou } from '~/utils/projects'

// Project overview data (design/project-overview.md), shared by the web page
// and MobileProjectOverview. Loads and stays live while its caller is mounted.
export function useProjectOverview() {
  const route = useRoute()
  const live = useLive()
  const slug = computed(() => String(route.params.slug))
  const project = computed(() => live.state.value.projects.find(p => p.slug === slug.value) ?? null)
  const tasks = computed<Task[]>(() => project.value ? live.state.value.tasks[project.value.id] ?? [] : [])
  const inbox = ref<Inbox | null>(null)
  const runs = ref<Run[]>([])
  const history = ref<AuditEntry[]>([])
  // The agent of each run behind the recent activity, by run id
  const runAgents = ref<Map<string, string>>(new Map())
  const error = ref<string | null>(null)
  useSeoMeta({ title: () => `${project.value?.name ?? 'Project'} · Corral` })

  async function load() {
    error.value = null
    try {
      if (project.value && !live.state.value.tasks[project.value.id]) await live.loadTasks(project.value)
      const [i, r] = await Promise.all([api.inbox.get(), api.runs.list({ active: true })])
      inbox.value = i
      runs.value = r.filter(run => run.projectId === project.value?.id)
      // Recent activity: the newest audit entries of this project's tasks
      const recent = [...tasks.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
      const [entries, taskRuns] = await Promise.all([
        Promise.all(recent.map(t => api.tasks.history(slug.value, t.number))),
        Promise.all(recent.map(t => api.runs.list({ taskId: t.id })))
      ])
      history.value = entries.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12)
      runAgents.value = new Map([...taskRuns.flat(), ...r].map(run => [run.id, run.agentName]))
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }
  watch(project, () => void load(), { immediate: true })
  onMounted(() => {
    const stop = live.subscribe((event) => {
      if (event.type === 'task.updated' || event.type === 'run.updated' || event.type === 'task.deleted') void load()
    })
    onBeforeUnmount(stop)
  })

  const DOT = { neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-error', success: 'bg-success', secondary: 'bg-secondary' } as const
  const count = (status: Task['status']) => tasks.value.filter(t => t.status === status).length
  const needsYou = computed(() => projectNeedsYou(inbox.value, project.value?.id))
  const weekAgo = Date.now() - 7 * 86_400_000
  const mergedThisWeek = computed(() => tasks.value.filter(t => t.mergedAt && new Date(t.mergedAt).getTime() > weekAgo))
  const firstPass = computed(() => {
    const merged = tasks.value.filter(t => t.status === 'merged')
    if (merged.length === 0) return null
    return Math.round(100 * merged.filter(t => t.reviewRounds === 0).length / merged.length)
  })
  const waitingOnDependency = computed(() => tasks.value.filter(t => t.status === 'ready' && (t.waitingOnEpics.length > 0 || t.dependsOn.some(ref => tasks.value.find(x => x.ref === ref)?.status !== 'merged'))).length)
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
    const groups = new Map<string, { id: string, title: string, merged: number, total: number }>()
    for (const task of tasks.value) {
      const id = task.epicId ?? 'none'
      const group = groups.get(id) ?? { id, title: id === 'none' ? 'No epic' : epicTitle(live.state.value.epics[project.value?.id ?? ''], id, groups.size), merged: 0, total: 0 }
      group.total++
      if (task.status === 'merged') group.merged++
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
