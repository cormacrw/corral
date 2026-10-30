import { queryOptions } from '@tanstack/vue-query'
import type { Agent, CreateAgentInput, PatchAgentInput } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import { keys } from './keys'

export const agentsQuery = () => queryOptions({ queryKey: keys.agents.list(), queryFn: () => api.agents.list() })

export const createAgent = defineMutation<Agent, CreateAgentInput>({
  mutationFn: input => api.agents.create(input),
  invalidates: [keys.agents.list()]
})
export const patchAgent = defineMutation<Agent, { id: string, input: PatchAgentInput }>({
  mutationFn: ({ id, input }) => api.agents.patch(id, input),
  invalidates: [keys.agents.list()]
})
