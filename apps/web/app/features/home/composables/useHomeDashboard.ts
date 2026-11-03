import { useQuery } from '@tanstack/vue-query'
import type { Agent, Run } from '@corral/contracts'
import { todayStats } from '~/features/agents/utils/agents'
import { dashboardCounts, elapsed, IN_PROGRESS_STAGES, liveRunTitle } from '~/features/home/utils/dashboard'
import { useNow } from '~/composables/useNow'
import { runsQuery } from '~/queries/runs'
import { agentStatus, epicInProgress, epicWithLiveCounts, isLiveRun, isWorking, STATUS } from '~/utils/labels'

const STAGE_COLOR: Record<typeof IN_PROGRESS_STAGES[number], string> = {
  in_progress: 'var(--brand)',
  agent_review: 'color-mix(in oklab, var(--brand) 55%, var(--background))',
  human_review: 'var(--warning)',
  ready_to_merge: 'var(--success)'
}

// Home, the global dashboard (design/mobile.md). Counts come from the live
// task lists the shell loads; runs come from the shared query, which events
// keep current.
export function useHomeDashboard() {
  const shell = useShell()
  const lists = useAllProjectLists(() => shell.projects)

  const runner = computed(() => {
    const status = shell.runner
    const online = Boolean(status?.online)
    const runners = status?.runners ?? []
    return { online, label: runners.length > 1 ? `${runners.filter(r => r.online).length} of ${runners.length} runners online` : `Runner ${online ? 'online' : 'offline'}` }
  })

  // All projects, or one project's numbers
  const projectId = ref<string>('all')
  const projectItems = computed(() => [
    { label: 'All projects', value: 'all' },
    ...shell.projects.map(p => ({ label: p.name, value: p.id }))
  ])
  const scope = computed(() => projectId.value === 'all' ? shell.projects : shell.projects.filter(p => p.id === projectId.value))

  const epics = computed(() => scope.value
    .flatMap(project => (lists.epics.value[project.id] ?? []).map(epic => ({ epic: epicWithLiveCounts(epic, lists.tasks.value[project.id] ?? []), project })))
    .filter(({ epic }) => (epic.taskId || epic.branch) && epicInProgress(epic))
    .sort((a, b) => Date.parse(b.epic.updatedAt) - Date.parse(a.epic.updatedAt)))

  // Re-render the "today" and elapsed numbers as time passes
  const now = useNow()
  const counts = computed(() => dashboardCounts(scope.value.flatMap(p => lists.tasks.value[p.id] ?? []), new Date(now.value)))
  const loading = computed(() => !shell.loaded || scope.value.some(p => lists.pending.value[p.id] ?? true))

  const stages = computed(() => IN_PROGRESS_STAGES.map(s => ({ key: s, label: STATUS[s].label, count: counts.value.stages[s], color: STAGE_COLOR[s] })))
  const attention = computed(() => {
    const { blocked, waitingForReview } = counts.value
    const parts = [blocked && `${blocked} blocked`, waitingForReview && `${waitingForReview} waiting for your review`].filter(Boolean)
    return parts.length ? parts.join(', ') : null
  })

  // If they fail, the agents still show, just without their current run
  const runsResult = useQuery(runsQuery())
  const runs = computed(() => runsResult.data.value ?? [])
  const today = computed(() => todayStats(
    runs.value.filter(r => scope.value.some(p => p.id === r.projectId)),
    [],
    now.value
  ))

  const taskOf = (run: Run) => run.taskId && run.projectId ? lists.tasks.value[run.projectId]?.find(t => t.id === run.taskId) : undefined
  const projectOf = (id: string | null) => shell.projects.find(p => p.id === id)
  // One line per active run: what it's on, where, and for how long
  const runLines = (agent: Agent) => runs.value
    .filter(r => isLiveRun(r) && r.agentId === agent.id && (r.projectId === null || scope.value.some(p => p.id === r.projectId)))
    .map((run) => {
      const task = taskOf(run)
      const session = run.taskId ? null : shell.planSessions.find(s => s.activeRunId === run.id)
      const project = projectOf(run.projectId)
      return {
        id: run.id,
        ref: run.taskRef ?? (run.epicId ? 'Parent' : null),
        taskRef: run.taskRef,
        title: liveRunTitle(run, session?.title ?? null),
        project,
        detail: [
          project?.name,
          task ? STATUS[task.status].label : null,
          // Reviews are about the PR; developer runs are about the run
          run.role === 'reviewer' && task?.pr?.number ? `PR #${task.pr?.number}` : `Run #${run.number}`,
          elapsed(run.startedAt ?? run.queuedAt, now.value)
        ].filter(Boolean).join(' · ')
      }
    })
  const agents = computed(() => shell.agents
    .map(agent => ({ agent, lines: runLines(agent), working: isWorking(agent), status: agentStatus(agent, now.value, false)?.label }))
    // Working agents first, in the shell's order otherwise
    .sort((a, b) => Number(b.working) - Number(a.working)))

  return {
    agentsLoaded: computed(() => shell.loaded),
    runner, projectId, projectItems, epics, counts, loading, stages, attention, today, agents,
    runsFailed: runsResult.isLoadingError, runsError: computed(() => runsResult.error.value?.message), retryRuns: () => runsResult.refetch()
  }
}
