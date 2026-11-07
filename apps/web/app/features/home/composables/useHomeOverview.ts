import { useQuery } from '@tanstack/vue-query'
import { todayStats } from '~/features/agents/utils/agents'
import { formatTokens } from '~/features/agents/utils/fleet'
import { formatDuration, mergedByDay, openWork, recentEpics, weekOverWeek } from '~/features/home/utils/overview'
import { workspaceFlowQuery } from '~/queries/projects'
import { isWorking, projectColor } from '~/utils/labels'

// The web Home (design/home.md): every project at a glance. Tasks and epics
// come from the lists the shell loads, runs from the shared history, and
// cycle time from the server, pooled across projects.
export function useHomeOverview() {
  const shell = useShell()
  const lists = useAllProjectLists(() => shell.projects)
  const history = useRunHistory()
  const flow = useQuery(workspaceFlowQuery('7d'))

  const projects = computed(() => shell.projects.map(p => ({ ...p, color: projectColor(p) })))
  const loading = computed(() => !shell.loaded || shell.projects.some(p => lists.pending.value[p.id] ?? true))

  const merged30 = computed(() => mergedByDay(shell.projects, lists.tasks.value, 30, history.now.value))
  const week = computed(() => weekOverWeek(merged30.value))

  const allTasks = computed(() => shell.projects.flatMap(p => lists.tasks.value[p.id] ?? []))
  const inFlight = computed(() => allTasks.value.filter(t => ['in_progress', 'agent_review', 'human_review', 'ready_to_merge'].includes(t.status)).length)
  const blocked = computed(() => allTasks.value.filter(t => t.status === 'blocked' || t.status === 'failed').length)
  const working = computed(() => shell.agents.filter(isWorking).length)

  const today = computed(() => {
    const stats = todayStats(history.runs.value, [], history.now.value)
    const failed = history.runs.value.filter(r => r.state === 'failed' && new Date(r.queuedAt).toDateString() === new Date(history.now.value).toDateString()).length
    return { ...stats, failed }
  })

  const cycle = computed(() => {
    const data = flow.data.value
    if (!data || data.current.mergedTaskCount === 0) return null
    const current = data.current.cycleTime.medianMs
    const previous = data.previous.mergedTaskCount ? data.previous.cycleTime.medianMs : null
    return {
      value: formatDuration(current),
      // Shown as a signed duration; negative is an improvement
      delta: previous === null ? undefined : current - previous,
      deltaLabel: previous === null ? undefined : `${current < previous ? '−' : '+'}${formatDuration(Math.abs(current - previous))}`,
      count: data.current.mergedTaskCount
    }
  })

  const kpis = computed(() => ({
    needsYou: shell.inboxCount,
    blocked: blocked.value,
    inFlight: inFlight.value,
    working: working.value,
    agents: shell.agents.length,
    mergedThisWeek: week.value.thisWeek,
    mergedDelta: week.value.thisWeek - week.value.lastWeek,
    mergedSpark: merged30.value.slice(-14).map(d => d.total),
    cycle: cycle.value,
    runsToday: today.value.runs,
    runsHint: `${formatTokens(today.value.tokens)} tokens${today.value.failed ? ` · ${today.value.failed} failed` : ''}`
  }))

  return {
    loading,
    projects,
    kpis,
    throughput: merged30,
    openWork: computed(() => openWork(projects.value, lists.tasks.value)),
    epics: computed(() => recentEpics(projects.value, lists.epics.value, lists.tasks.value, 6)),
    runs: history.runs,
    runsLoading: history.loading,
    now: history.now,
    runsFailed: history.failed,
    runsError: history.error,
    retryRuns: history.retry
  }
}
