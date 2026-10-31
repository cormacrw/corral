import { queryOptions } from '@tanstack/vue-query'
import type { Plan } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import { keys } from './keys'

export const planSessionsQuery = () => queryOptions({ queryKey: keys.plan.sessions(), queryFn: () => api.plan.sessions() })
export const planSessionQuery = (id: string) => queryOptions({ queryKey: keys.plan.session(id), queryFn: () => api.plan.session(id) })
export const planDraftsQuery = (slug: string) => queryOptions({ queryKey: keys.plan.drafts(slug), queryFn: () => api.plan.drafts(slug) })

export const approvePlan = defineMutation<Plan, { planId: string, to: 'ready' | 'backlog' }>({
  mutationFn: ({ planId, to }) => api.plan.approve(planId, to),
  invalidates: [keys.plan.all(), keys.tasks.lists(), keys.inbox()]
})
export const discardPlan = defineMutation<Plan, string>({
  mutationFn: planId => api.plan.discard(planId),
  invalidates: [keys.plan.all(), keys.inbox()]
})
