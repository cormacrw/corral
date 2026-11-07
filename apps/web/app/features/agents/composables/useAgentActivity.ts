import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { startOfDay } from '~/features/home/utils/overview'
import { dayBars, medianMinutesByDay, outcomesByDay, tokensByDay } from '~/features/agents/utils/fleet'
import { useNow } from '~/composables/useNow'
import { runsQuery } from '~/queries/runs'
import { RUN_HISTORY_DAYS } from './useRunHistory'

// One agent's charts (design/agent.md): its own runs since local midnight
// 13 days ago, `GET /api/runs?agentId=&since=`. Asking for this agent alone
// means the fleet history's 2000-run cap can't cut off a quiet agent's
// oldest days. Run events keep the list current; the key changes once a day.
export const ACTIVITY_DAYS = 7
export const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24]
export const hourTick = (v: number) => `${String(v).padStart(2, '0')}:00`

// `alsoRetry` is the page's latest-50 runs refetch (`useAgentRuns().load`),
// so one Retry reloads both
export function useAgentActivity(agentId: MaybeRefOrGetter<string | null | undefined>, alsoRetry?: () => Promise<unknown>) {
  const now = useNow()
  const id = computed(() => toValue(agentId) ?? null)
  const since = computed(() => new Date(startOfDay(now.value) - (RUN_HISTORY_DAYS - 1) * 86_400_000).toISOString())
  const result = useQuery(computed(() => ({ ...runsQuery({ agentId: id.value ?? undefined, since: since.value }), enabled: !!id.value })))
  const runs = computed(() => result.data.value ?? [])
  const lengths = computed(() => medianMinutesByDay(runs.value, RUN_HISTORY_DAYS, now.value))
  return {
    now,
    runs,
    loading: computed(() => result.isPending.value),
    failed: result.isLoadingError,
    error: computed(() => result.error.value?.message ?? null),
    refetch: () => result.refetch(),
    retry: () => Promise.all([result.refetch(), alsoRetry?.()]),
    // The last 7 days, a lane for each day with runs, hour of day across
    bars: computed(() => dayBars(runs.value, ACTIVITY_DAYS, now.value)),
    outcomes: computed(() => outcomesByDay(runs.value, RUN_HISTORY_DAYS, now.value)),
    // For `AgentsTokenChart` with `only=<role>`: this agent's runs are all its role
    tokens: computed(() => tokensByDay(runs.value, RUN_HISTORY_DAYS, now.value)),
    // The Avg tile's sparkline: days with no finished run are gaps, and it
    // needs 2 or more days to draw a line, so it's null until then
    lengths: computed(() => {
      const days = lengths.value.filter((m): m is number => m !== null)
      return days.length >= 2 ? days : null
    })
  }
}

export type AgentActivity = ReturnType<typeof useAgentActivity>
