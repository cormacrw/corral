import type { QueryClient } from '@tanstack/vue-query'
import { keys } from '~/queries/keys'
import type { AgentRuntime, PlanSessionDetail, ServerEvent } from '@corral/contracts'
import { startPlanThread } from '~/queries/plan'

let queryClient: QueryClient | null = null

// Installed by the client plugin, so reconciliation also runs after navigation.
export function connectPendingPlanCache(client: QueryClient) {
  queryClient = client
}

interface PendingPlan {
  session: PlanSessionDetail
  message: string
  taskRef?: string
  state: 'starting' | 'accepted' | 'failed'
  error: string | null
  sending: boolean
  sessionReceived: boolean
}

// Shared across route changes; the server remains the source of truth on reload.
export function usePendingPlan() {
  const entries = useState<Record<string, PendingPlan>>('pending-plan', () => ({}))
  const restored = useState<PendingPlan | null>('restored-plan', () => null)

  function seed(projectId: string | null, message: string, runtime: AgentRuntime, taskRef?: string) {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    entries.value[id] = {
      message, taskRef, state: 'starting', error: null, sending: false, sessionReceived: false,
      session: {
        id, projectId, runtime, title: (message || `Refine ${taskRef}`).split('\n')[0]!.slice(0, 60), preview: message,
        unread: false, closed: false, status: 'none', activeRunId: null, createdAt: now, updatedAt: now,
        messages: [{ id: `pending-${id}`, sessionId: id, role: 'human', kind: 'message', text: message || `Refine ${taskRef}`, recommendation: null, options: null, planId: null, runId: null, createdAt: now }], plans: []
      }
    }
    queryClient?.setQueryData(keys.plan.session(id), JSON.parse(JSON.stringify(entries.value[id]!.session)))
    return id
  }

  function accept(id: string, session: PlanSessionDetail) {
    const entry = entries.value[id]
    if (!entry) return
    // Events can beat the POST response. Preserve their newer messages and metadata.
    const messages = new Map(session.messages.map(m => [m.id, m]))
    for (const message of entry.session.messages) {
      if (!message.id.startsWith('pending-')) messages.set(message.id, message)
    }
    const plans = new Map(session.plans.map(plan => [plan.id, plan]))
    for (const plan of entry.session.plans) plans.set(plan.id, plan)
    entry.session = { ...session, ...(entry.sessionReceived ? entry.session : {}), messages: [...messages.values()], plans: [...plans.values()] }
    entry.sessionReceived = true
    entry.state = 'accepted'
    entry.error = null
    queryClient?.setQueryData(keys.plan.session(id), JSON.parse(JSON.stringify(entry.session)))
  }

  async function start(id: string) {
    const entry = entries.value[id]
    if (!entry || entry.state === 'accepted' || entry.sending) return
    entry.sending = true
    entry.state = 'starting'
    entry.error = null
    try {
      accept(id, await startPlanThread(entry.session, entry.message, entry.taskRef, id))
    } catch (error) {
      // A live message/session proves acceptance even if the response was lost.
      if (entries.value[id]?.state === 'accepted') return
      entry.state = 'failed'
      entry.error = error instanceof Error ? error.message : String(error)
    } finally {
      entry.sending = false
    }
  }

  function apply(event: ServerEvent) {
    if (event.type === 'plan.session') {
      const entry = entries.value[event.session.id]
      if (!entry) return
      Object.assign(entry.session, event.session)
      entry.sessionReceived = true
      entry.state = 'accepted'
      entry.error = null
    } else if (event.type === 'plan.updated') {
      const entry = entries.value[event.plan.sessionId]
      if (!entry) return
      const index = entry.session.plans.findIndex(p => p.id === event.plan.id)
      if (index < 0) entry.session.plans.push(event.plan)
      else entry.session.plans.splice(index, 1, event.plan)
    } else if (event.type === 'plan.message') {
      const entry = entries.value[event.message.sessionId]
      if (!entry) return
      if (event.message.role === 'human') entry.session.messages = entry.session.messages.filter(m => !m.id.startsWith('pending-'))
      if (!entry.session.messages.some(m => m.id === event.message.id)) entry.session.messages.push(event.message)
      entry.state = 'accepted'
      entry.error = null
    }
  }

  return { entries, restored, seed, start, apply }
}
