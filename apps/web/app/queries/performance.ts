import { queryOptions } from '@tanstack/vue-query'
import type { PerfWindow } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { keys } from './keys'

export const performanceQuery = (window: PerfWindow) => queryOptions({
  queryKey: keys.performance(window),
  queryFn: () => api.perfSummary(window)
})
