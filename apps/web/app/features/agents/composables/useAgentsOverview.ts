import { todayStats } from '~/features/agents/utils/agents'
import { busyShare, runBars, tokensByDay } from '~/features/agents/utils/fleet'
import { agentStatus, isWorking, runnerSummary, tokens as formatTokens } from '~/utils/labels'
import { sameDay } from '~/utils/days'

// The Agents page (design/agent.md, Agents): every agent's last 12 hours,
// tokens over 14 days and how busy each one has been
export const TIMELINE_HOURS = 12

export function useAgentsOverview() {
  const shell = useShell()
  const history = useRunHistory()
  const { runs, now } = history

  const tokens = computed(() => tokensByDay(runs.value, RUN_HISTORY_DAYS, now.value))
  const today = computed(() => todayStats(runs.value, now.value))
  // Today's tokens against the average of the days before it in the window
  const tokenTrend = computed(() => {
    const totals = tokens.value.map(d => Object.values(d.byRole).reduce((a, b) => a + b, 0))
    const before = totals.slice(0, -1).filter(n => n > 0)
    if (!before.length) return null
    const average = before.reduce((a, b) => a + b, 0) / before.length
    return Math.round(((totals.at(-1)! - average) / average) * 100)
  })
  const failedToday = computed(() => runs.value.filter(r => r.state === 'failed' && sameDay(r.queuedAt, now.value)).length)

  const runner = computed(() => ({
    online: Boolean(shell.runner?.online),
    label: shell.runner?.online ? 'Online' : 'Offline',
    hint: runnerSummary(shell.runner ?? null)
  }))

  const agents = computed(() => shell.agents.map(agent => ({
    agent,
    working: isWorking(agent),
    status: agentStatus(agent, now.value, true),
    busy: busyShare(runs.value, agent, TIMELINE_HOURS, now.value),
    runsToday: runs.value.filter(r => r.agentId === agent.id && sameDay(r.queuedAt, now.value)).length
  })))

  return {
    failed: history.failed,
    error: history.error,
    retry: history.retry,
    stats: computed(() => ({
      runsToday: today.value.runs,
      failedToday: failedToday.value,
      tokensToday: formatTokens(today.value.tokens),
      tokenTrend: tokenTrend.value,
      working: agents.value.filter(a => a.working).length,
      total: agents.value.length,
      paused: shell.agents.filter(a => a.paused).length,
      limited: shell.agents.filter(a => a.pausedUntil && Date.parse(a.pausedUntil) > now.value).length
    })),
    runner,
    bars: computed(() => runBars(runs.value, shell.agents, TIMELINE_HOURS, now.value)),
    tokens,
    agents
  }
}
