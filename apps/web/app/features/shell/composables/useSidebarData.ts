import type { Project } from '@corral/contracts'
import { useLive } from '~/queries/stream'
import { agentStatus, projectColor, runnerSummary, taskCounts } from '~/utils/labels'

// Everything the sidebar shows, derived once so its sections stay presentational
export function useSidebarData() {
  const shell = useShell()
  const { connection } = useLive()
  const lists = useAllProjectLists(() => shell.projects)
  const route = useRoute()

  // An agent's status only changes with time when a usage-limit wait runs out,
  // so this wakes for that and nothing else. setTimeout can't wait past 2^31 ms.
  const now = ref(Date.now())
  let usageWait: ReturnType<typeof setTimeout> | undefined
  function watchUsageWaits() {
    clearTimeout(usageWait)
    now.value = Date.now()
    const waits = shell.agents.map(a => a.pausedUntil ? new Date(a.pausedUntil).getTime() - now.value : 0).filter(ms => ms > 0)
    if (waits.length) usageWait = setTimeout(watchUsageWaits, Math.min(...waits, 2 ** 31 - 1))
  }
  watch(() => shell.agents, watchUsageWaits, { immediate: true })
  onBeforeUnmount(() => clearTimeout(usageWait))

  const expanded = useLocalStorage<Record<string, boolean>>('corral.sidebar.projects', {})
  const isExpanded = (project: Project) => expanded.value[project.id] ?? true
  const toggle = (project: Project) => {
    expanded.value = { ...expanded.value, [project.id]: !isExpanded(project) }
  }

  const counts = computed(() => new Map(shell.projects.map(p => [p.id, taskCounts(lists.tasks.value[p.id] ?? [])])))
  const threadColor = (projectId: string | null) => {
    const project = shell.projects.find(p => p.id === projectId)
    return project ? projectColor(project) : undefined
  }
  const runnerTone = computed(() => !shell.runner?.online ? 'error' : connection.value === 'open' ? 'success' : 'warning')
  const isActive = (path: string) => route.path === path || route.path.startsWith(`${path}/`)
  const statusOf = (agent: typeof shell.agents[number]) => agentStatus(agent, now.value)?.label

  return { shell, lists, counts, isActive, isExpanded, toggle, threadColor, runnerTone, statusOf, runnerSummary }
}
