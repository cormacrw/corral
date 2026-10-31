import { queryOptions } from '@tanstack/vue-query'
import type { Run } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import type { RunFilter } from './keys'
import { keys } from './keys'

export const runsQuery = (filter: RunFilter = {}) => queryOptions({ queryKey: keys.runs.list(filter), queryFn: () => api.runs.list(filter) })
// Only ever grows at the end, so comparing it all on each line finds nothing
export const runTranscriptQuery = (id: string) => queryOptions({ queryKey: keys.runs.transcript(id), queryFn: () => api.runs.transcript(id), structuralSharing: false })

// Its comment and transcript line arrive as events
export const messageRun = ({ slug, id, text }: { slug: string, id: string, text: string }) => api.runs.message(slug, id, text)

export const stopRun = defineMutation<Run, string>({
  mutationFn: id => api.runs.stop(id),
  invalidates: (_, id) => [keys.runs.lists(), keys.runs.detail(id), keys.agents.list()]
})
