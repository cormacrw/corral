import { queryOptions } from '@tanstack/vue-query'
import type { Run } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import type { RunFilter } from './keys'
import { keys } from './keys'

export const runsQuery = (filter: RunFilter = {}) => queryOptions({ queryKey: keys.runs.list(filter), queryFn: () => api.runs.list(filter) })
export const runQuery = (id: string) => queryOptions({ queryKey: keys.runs.detail(id), queryFn: () => api.runs.get(id) })
export const runTranscriptQuery = (id: string) => queryOptions({ queryKey: keys.runs.transcript(id), queryFn: () => api.runs.transcript(id) })

export const stopRun = defineMutation<Run, string>({
  mutationFn: id => api.runs.stop(id),
  invalidates: (_, id) => [keys.runs.lists(), keys.runs.detail(id), keys.agents.list()]
})
