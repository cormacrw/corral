import { queryOptions } from '@tanstack/vue-query'
import type { Epic, PatchEpicInput } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import { keys } from './keys'

export const epicsQuery = (slug: string) => queryOptions({ queryKey: keys.epics.list(slug), queryFn: () => api.epics.list(slug) })
export const epicQuery = (id: string) => queryOptions({ queryKey: keys.epics.detail(id), queryFn: () => api.epics.get(id) })

export const patchEpic = defineMutation<Epic, { id: string, input: PatchEpicInput }>({
  mutationFn: ({ id, input }) => api.epics.patch(id, input),
  invalidates: (_, { id }) => [keys.epics.lists(), keys.epics.detail(id)]
})

export const setEpicDependencies = defineMutation<Epic, { id: string, dependsOn: string[] }>({
  mutationFn: ({ id, dependsOn }) => api.epics.setDependencies(id, dependsOn),
  invalidates: (_, { id }) => [keys.epics.lists(), keys.epics.detail(id), keys.tasks.lists()]
})
