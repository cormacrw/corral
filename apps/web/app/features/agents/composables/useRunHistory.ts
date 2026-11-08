import { useQuery } from '@tanstack/vue-query'
import { DAY_MS, startOfDay } from '~/utils/days'
import { useNow } from '~/composables/useNow'
import { runHistoryQuery } from '~/queries/runs'

// The last `days` days of runs, shared by Home and Agents (one cache entry
// per day), with a clock for figures that move as time passes
export const RUN_HISTORY_DAYS = 14

export function useRunHistory() {
  const now = useNow()
  const since = computed(() => new Date(startOfDay(now.value) - (RUN_HISTORY_DAYS - 1) * DAY_MS).toISOString())
  const result = useQuery(computed(() => runHistoryQuery(since.value)))
  return {
    now,
    runs: computed(() => result.data.value ?? []),
    failed: result.isLoadingError,
    error: computed(() => result.error.value?.message),
    retry: () => result.refetch()
  }
}
