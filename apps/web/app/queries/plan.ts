import { queryOptions } from '@tanstack/vue-query'
import type { QueryClient } from '@tanstack/vue-query'
import type { Inbox, Plan, PlanMessage, PlanSession, PlanSessionDetail } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation, inboxWithRead } from './dependencies'
import { keys } from './keys'

export const planSessionsQuery = () => queryOptions({ queryKey: keys.plan.sessions(), queryFn: () => api.plan.sessions() })
export const planSessionQuery = (id: string) => queryOptions({
  queryKey: keys.plan.session(id),
  queryFn: async ({ client }) => {
    const before = client.getQueryData<PlanSessionDetail>(keys.plan.session(id))
    const saved = await api.plan.session(id)
    const current = client.getQueryData<PlanSessionDetail>(keys.plan.session(id))
    // A transcript or session event can land while the snapshot is in flight.
    // Keep those newer writes visible while the normal event queue catches up.
    if (!current || current === before) return saved
    const messages = new Map(saved.messages.map(message => [message.id, message]))
    for (const message of current.messages) {
      if (!message.id.startsWith('pending-') && !before?.messages.some(old => old === message)) messages.set(message.id, message)
    }
    const plans = new Map(saved.plans.map(plan => [plan.id, plan]))
    for (const plan of current.plans) {
      if (!before?.plans.some(old => old === plan)) plans.set(plan.id, plan)
    }
    const changes = Object.fromEntries(Object.entries(current).filter(([key, value]) => !before || before[key as keyof PlanSessionDetail] !== value))
    return { ...saved, ...changes, messages: [...messages.values()], plans: [...plans.values()] }
  }
})
export const planDraftsQuery = (slug: string) => queryOptions({ queryKey: keys.plan.drafts(slug), queryFn: () => api.plan.drafts(slug) })

export const approvePlan = defineMutation<Plan, { planId: string, to: 'ready' | 'backlog' }>({
  mutationFn: ({ planId, to }) => api.plan.approve(planId, to),
  invalidates: [keys.plan.all(), keys.tasks.lists(), keys.inbox()]
})

// Not a mutation: its result reconciles usePendingPlan's entry, which outlives
// any component
export const startPlanThread = (session: Pick<PlanSession, 'projectId' | 'runtime'>, message: string, taskRef: string | undefined, id: string) =>
  api.plan.start(session.projectId, message, taskRef, session.runtime, id)

// For a page being closed: the request has to outlive it, and nothing is left
// to invalidate
export const closePlanThreadOnExit = (id: string) => api.plan.close(id, { keepalive: true })

export const closePlanThread = defineMutation<Awaited<ReturnType<typeof api.plan.close>>, string>({
  mutationFn: id => api.plan.close(id),
  invalidates: [keys.plan.all(), keys.inbox()]
})

// Reading is an acknowledgement, not a content change. Patch in place and
// never invalidate: its plan.session echo must not reorder or refetch lists.
export function markPlanRead(client: QueryClient, id: string): void {
  client.setQueryData<PlanSessionDetail>(keys.plan.session(id), session => session && { ...session, unread: false })
  client.setQueryData<PlanSession[]>(keys.plan.sessions(), sessions => sessions?.map(session => session.id === id ? { ...session, unread: false } : session))
  client.setQueryData<Inbox>(keys.inbox(), inbox => inbox && inboxWithRead(inbox, id))
  void api.plan.read(id).catch(() => {})
}

export const sendPlanMessage = defineMutation<PlanMessage, { id: string, text: string, taskRef?: string }>({
  mutationFn: ({ id, text, taskRef }) => api.plan.message(id, text, taskRef),
  invalidates: [keys.inbox()]
})
