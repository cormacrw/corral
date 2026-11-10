import { errorText } from '@corral/core'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { QueryClient } from '@tanstack/vue-query'
import type { Plan, PlanMessage, PlanSessionDetail, PmActionDecision } from '@corral/contracts'
import type { AgentRuntime, PlanApprovalTarget } from '@corral/core'
import { computed, watch } from 'vue'
import { api } from './api'
import { defineMutation, writeQuery, type PlanStart, type PlanStarts } from './dependencies'
import { markRead } from './inbox'
import { isPendingId, keys, pendingId } from './keys'

export const planSessionsQuery = () => queryOptions({ queryKey: keys.plan.sessions(), queryFn: () => api.plan.sessions() })
export const planSessionQuery = (id: string) => queryOptions({ queryKey: keys.plan.session(id), queryFn: () => api.plan.session(id) })
export const planDraftsQuery = (slug: string) => queryOptions({ queryKey: keys.plan.drafts(slug), queryFn: () => api.plan.drafts(slug) })

// A thread on screen is read, as it opens and as each reply lands (D11). Only
// an open conversation or Inbox pane observes a session, so an observed
// session is one on screen.
export const threadOnScreen = (client: QueryClient, id: string) =>
  client.getQueryCache().find({ queryKey: keys.plan.session(id), exact: true })?.isActive() ?? false

// The session of a thread on screen, which reads it while unread
export function useThreadSession(id: () => string, enabled: () => boolean = () => true) {
  const detail = useQuery(computed(() => ({ ...planSessionQuery(id()), enabled: enabled() })))
  const read = useMutation(markRead)
  watch([id, () => detail.data.value?.unread], ([id, unread]) => {
    if (unread) read.mutate({ type: 'plan_thread', id })
  }, { immediate: true })
  return detail
}

export const approvePlan = defineMutation<Plan, { planId: string, to: PlanApprovalTarget }>({
  mutationFn: ({ planId, to }) => api.plan.approve(planId, to),
  invalidates: [keys.plan.all(), keys.tasks.lists(), keys.inbox()]
})

// The confirmation card's answer: the PM's turn and its events bring the rest
export const resolvePlanAction = defineMutation<PlanMessage, { sessionId: string, messageId: string, decision: PmActionDecision }>({
  mutationFn: ({ sessionId, messageId, decision }) => api.plan.resolveAction(sessionId, messageId, decision),
  invalidates: ({ sessionId }) => [keys.plan.session(sessionId)]
})

// For a page being closed: the request has to outlive it, and nothing is left
// to invalidate
export const closePlanThreadOnExit = (id: string) => api.plan.close(id, { keepalive: true })

export const closePlanThread = defineMutation<Awaited<ReturnType<typeof api.plan.close>>, string>({
  mutationFn: id => api.plan.close(id),
  invalidates: [keys.plan.all(), keys.inbox()]
})

export const sendPlanMessage = defineMutation<PlanMessage, { id: string, text: string, taskRef?: string }>({
  mutationFn: ({ id, text, taskRef }) => api.plan.message(id, text, taskRef),
  invalidates: [keys.inbox()],
  // Whether the PM's turn is still running is only known to the server
  refreshes: (_, { id }) => [keys.plan.session(id)]
})

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))

// Threads started here (optimistic-plan-starts.md). The new-session page seeds
// one before navigating to it and the POST runs after, so the thread shows at
// once. Kept in the cache, so events reach a start whether or not its thread
// is mounted, and the POST's result lands after navigation away.
export function usePlanStarts() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: keys.plan.starts(), queryFn: () => ({}) as PlanStarts, initialData: {} as PlanStarts, enabled: false, staleTime: Infinity, gcTime: Infinity })
  const entries = computed(() => query.data.value ?? {})
  const current = (id: string) => client.getQueryData<PlanStarts>(keys.plan.starts())?.[id]
  const update = (id: string, change: (start: PlanStart) => Partial<PlanStart>) =>
    writeQuery<PlanStarts>(client, keys.plan.starts(), starts => starts?.[id] ? { ...starts, [id]: { ...starts[id], ...change(starts[id]) } } : starts)

  function seed(projectId: string | null, message: string, runtime: AgentRuntime, taskRef?: string): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const text = message || `Refine ${taskRef}`
    const session: PlanSessionDetail = {
      id, projectId, runtime, title: text.split('\n')[0]!.slice(0, 60), preview: message,
      unread: false, closed: false, status: 'none', activeRunId: null, createdAt: now, updatedAt: now,
      messages: [{ id: pendingId(id), sessionId: id, role: 'human', kind: 'message', text, recommendation: null, options: null, planId: null, runId: null, createdAt: now }], plans: []
    }
    client.setQueryData<PlanStarts>(keys.plan.starts(), starts => ({ ...starts, [id]: { session, message, taskRef, state: 'starting', error: null, sending: false, sessionReceived: false } }))
    client.setQueryData(keys.plan.session(id), copy(session))
    return id
  }

  // Events can beat the POST response: their messages, plans and (from a
  // plan.session) metadata are newer
  function accept(id: string, saved: PlanSessionDetail) {
    const start = current(id)
    if (!start) return
    const messages = new Map(saved.messages.map(m => [m.id, m]))
    for (const message of start.session.messages) {
      if (!isPendingId(message.id)) messages.set(message.id, message)
    }
    const plans = new Map(saved.plans.map(plan => [plan.id, plan]))
    for (const plan of start.session.plans) plans.set(plan.id, plan)
    const session = { ...saved, ...(start.sessionReceived ? start.session : {}), messages: [...messages.values()], plans: [...plans.values()] }
    update(id, () => ({ session, sessionReceived: true, state: 'accepted', error: null }))
    client.setQueryData(keys.plan.session(id), copy(session))
  }

  async function start(id: string) {
    const entry = current(id)
    if (!entry || entry.state === 'accepted' || entry.sending) return
    update(id, () => ({ sending: true, state: 'starting', error: null }))
    try {
      accept(id, await api.plan.start(entry.session.projectId, entry.message, entry.taskRef, entry.session.runtime, id))
    } catch (error) {
      // A live message or session proves acceptance even if the response was lost
      update(id, start => start.state === 'accepted' ? {} : { state: 'failed', error: errorText(error) })
    } finally {
      update(id, () => ({ sending: false }))
    }
  }

  return { entries, seed, start }
}
