import type { AuditEntry, Inbox, Run, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { epicTitle } from '~/utils/labels'

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
      const entries = await Promise.all(recent.map(t => api.tasks.history(slug.value, t.number)))
      history.value = entries.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12)
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
  const needsYou = computed(() => inbox.value?.needsYou.filter(i => i.project.id === project.value?.id) ?? [])
  const weekAgo = Date.now() - 7 * 86_400_000
  const mergedThisWeek = computed(() => tasks.value.filter(t => t.mergedAt && new Date(t.mergedAt).getTime() > weekAgo))
  const firstPass = computed(() => {
    const merged = tasks.value.filter(t => t.status === 'merged')
    if (merged.length === 0) return null
    return Math.round(100 * merged.filter(t => t.reviewRounds === 0).length / merged.length)
  })
  const waitingOnDependency = computed(() => tasks.value.filter(t => t.status === 'ready' && t.dependsOn.some(ref => tasks.value.find(x => x.ref === ref)?.status !== 'merged')).length)
  const developer = computed(() => live.state.value.agents.find(a => a.role === 'developer'))
  const reviewer = computed(() => live.state.value.agents.find(a => a.role === 'reviewer'))
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
  const actorName = (entry: AuditEntry) => entry.actor.kind === 'human' ? 'You' : entry.actor.kind === 'agent' ? (entry.actor.role === 'pm' ? live.state.value.agents.find(a => a.role === 'pm')?.name ?? 'PM' : entry.actor.role === 'developer' ? developer.value?.name ?? 'Developer' : reviewer.value?.name ?? 'Reviewer') : 'Corral'
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
