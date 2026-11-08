import { useQuery } from '@tanstack/vue-query'
import { startOfDay } from '~/utils/days'
import { useNow } from '~/composables/useNow'
import { runHistoryQuery } from '~/queries/runs'

// The last `days` days of runs, shared by Home and Agents (one cache entry
// per day), with a clock for figures that move as time passes
export const RUN_HISTORY_DAYS = 14
// Local midnight at the start of the history, by calendar days so a clock
// change in between doesn't move it off midnight
export function historySince(now: number): string {
  const day = new Date(startOfDay(now))
  day.setDate(day.getDate() - (RUN_HISTORY_DAYS - 1))
  return day.toISOString()
}

export function useRunHistory() {
  const now = useNow()
  const since = computed(() => historySince(now.value))
  const result = useQuery(computed(() => runHistoryQuery(since.value)))
  return {
    now,
    runs: computed(() => result.data.value ?? []),
    loading: computed(() => result.isPending.value),
    failed: result.isLoadingError,
    error: computed(() => result.error.value?.message),
    retry: () => result.refetch()
  }
}
