import { useQuery } from '@tanstack/vue-query'
import { clisQuery } from '~/queries/setup'

// The CLIs detected inside the runner, for setup and Settings. `enabled` holds
// the scan back until the step that shows it opens.
export function useCliScan(enabled: () => boolean = () => true) {
  const query = useQuery(computed(() => ({ ...clisQuery(), enabled: enabled() })))
  return {
    clis: computed(() => query.data.value ?? null),
    cliError: computed(() => query.error.value?.message ?? null),
    scan: () => query.refetch()
  }
}
