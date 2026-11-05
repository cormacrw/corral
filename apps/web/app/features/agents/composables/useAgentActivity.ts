import type { Agent } from '@corral/contracts'
import { dayBars, medianMinutesByDay, outcomesByDay, tokensByDay } from '~/features/agents/utils/fleet'

// One agent's charts (design/agent.md, Activity), from the same 14-day run
// history as Home and Agents (`GET /api/runs?since=`), filtered to this
// agent. The recent runs list keeps its own 50-run window.
export const ACTIVITY_DAYS = 7

export function useAgentActivity(agent: Ref<Agent | null>) {
  const history = useRunHistory()
  const { now } = history
  const runs = computed(() => agent.value ? history.runs.value.filter(r => r.agentId === agent.value!.id) : [])
  return {
    loading: history.loading,
    failed: history.failed,
    error: history.error,
    retry: history.retry,
    // The last 7 days, a lane each, hour of day across
    bars: computed(() => dayBars(runs.value, ACTIVITY_DAYS, now.value)),
    outcomes: computed(() => outcomesByDay(runs.value, RUN_HISTORY_DAYS, now.value)),
    tokens: computed(() => tokensByDay(runs.value, RUN_HISTORY_DAYS, now.value)),
    // Days with no finished run are gaps, not zeros
    lengths: computed(() => medianMinutesByDay(runs.value, RUN_HISTORY_DAYS, now.value).filter((m): m is number => m !== null))
  }
}

export const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24]
export const hourTick = (v: number) => `${String(v % 24).padStart(2, '0')}:00`
