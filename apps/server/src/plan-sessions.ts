import { planMessageFields, type NewPlanMessageFields, type PlanMessage, type PlanSession } from '@corral/contracts'
import { LIVE_RUN_STATES, type AgentRuntime, type PmAction } from '@corral/core'
import { schema, type Database, type Executor, type PlanSessionRow } from '@corral/db'
import { and, desc, eq, inArray, notInArray, or } from 'drizzle-orm'
import { notFound } from './errors.ts'
import type { EventBus } from './events.ts'

// Plan sessions' messages and what each session shows: the store every part
// of Plan writes through, and the read model the Inbox shares (D9, D11)

const { planMessages, planSessions, plans, runs } = schema

interface MessageLinks {
  planId?: string
  runId?: string | null
  senderSessionId?: string | null
  senderTitle?: string | null
  pendingAction?: PmAction
}

// Every message is written here, so its fields match its role and kind
export async function insertMessage(db: Executor, sessionId: string, fields: NewPlanMessageFields, links: MessageLinks = {}): Promise<typeof planMessages.$inferSelect> {
  const [row] = await db.insert(planMessages).values({ ...planMessageFields.parse(fields), sessionId, ...links }).returning()
  return row!
}

// Rows older than the constraints aren't checked, so the role and kind are
// read defensively: anything unknown shows as a plain PM message, and only a
// PM question keeps its question fields.
export function toMessage(row: typeof planMessages.$inferSelect): PlanMessage {
  const message = {
    id: row.id,
    sessionId: row.sessionId,
    senderSessionId: row.senderSessionId,
    senderTitle: row.senderTitle,
    text: row.text,
    pendingAction: row.pendingAction,
    planId: row.planId,
    runId: row.runId,
    createdAt: row.createdAt.toISOString()
  }
  if (row.role === 'human') return { ...message, role: 'human', kind: 'message', recommendation: null, options: null }
  if (row.role === 'thread') return { ...message, role: 'thread', kind: row.kind === 'notification' ? 'notification' : 'message', recommendation: null, options: null }
  if (row.kind === 'question') return { ...message, role: 'pm', kind: 'question', recommendation: row.recommendation, options: row.options }
  return { ...message, role: 'pm', kind: row.kind === 'error' || row.kind === 'confirmation' || row.kind === 'action_result' ? row.kind : 'message', recommendation: null, options: null }
}

// Something happened in the session, inside the writer's transaction. `unread`
// when it's something new for the human to read; child threads' activity
// isn't (D11).
export async function touchSession(db: Executor, sessionId: string, { unread }: { unread: boolean }): Promise<void> {
  await db.update(planSessions).set({ updatedAt: new Date(), ...(unread && { unread: true }) }).where(eq(planSessions.id, sessionId))
}

// What a session is waiting on. A question or a proposed plan comes with its
// row, so the status can't be shown without it.
export type SessionAttention =
  | { status: 'needs_approval', plan: typeof plans.$inferSelect }
  | { status: 'question', question: typeof planMessages.$inferSelect }
  // The PM's last turn ended in an error. Nothing retries a turn, so the
  // session waits on the human's message or closing it, read or not (D11).
  | { status: 'failed', failure: typeof planMessages.$inferSelect }
  | { status: 'none' }

// A session as the API shows it, with what it waits on, which the Inbox's Plan
// thread items also need (D11)
export async function sessionState(db: Executor, row: PlanSessionRow, activeRunId?: string | null) {
  return (await sessionStates(db, [row], activeRunId))[0]!
}

// One state per row. `activeRunId` is the caller's own knowledge of one
// session's run; otherwise each is read.
export async function sessionStates(db: Executor, rows: PlanSessionRow[], activeRunId?: string | null): Promise<{ session: PlanSession, attention: SessionAttention }[]> {
  if (rows.length === 0) return []
  const ids = rows.map(r => r.id)
  const [lastMessages, lastConversations, lastTurns, proposedPlans, activeRuns] = await Promise.all([
    db.selectDistinctOn([planMessages.sessionId]).from(planMessages).where(inArray(planMessages.sessionId, ids)).orderBy(planMessages.sessionId, desc(planMessages.createdAt)),
    // Completion notices and confirm results add context; they don't change a
    // turn's outcome. A failure is only the last message otherwise: a reply
    // restored after it means the turn didn't fail.
    db.selectDistinctOn([planMessages.sessionId]).from(planMessages)
      .where(and(inArray(planMessages.sessionId, ids), notInArray(planMessages.kind, ['notification', 'action_result']))).orderBy(planMessages.sessionId, desc(planMessages.createdAt)),
    // A question stands until the human writes: the PM's closing words after
    // ask_question are a plain message and don't answer it (D11).
    db.selectDistinctOn([planMessages.sessionId]).from(planMessages)
      .where(and(inArray(planMessages.sessionId, ids), or(eq(planMessages.role, 'human'), eq(planMessages.kind, 'question'))))
      .orderBy(planMessages.sessionId, desc(planMessages.createdAt)),
    db.select().from(plans).where(and(inArray(plans.sessionId, ids), eq(plans.status, 'proposed'))),
    activeRunId === undefined
      ? db.select({ id: runs.id, sessionId: runs.planSessionId }).from(runs)
          .where(and(eq(runs.role, 'pm'), inArray(runs.planSessionId, ids), inArray(runs.state, [...LIVE_RUN_STATES])))
      : []
  ])
  const lastOf = new Map(lastMessages.map(m => [m.sessionId, m]))
  const conversationOf = new Map(lastConversations.map(m => [m.sessionId, m]))
  const turnOf = new Map(lastTurns.map(m => [m.sessionId, m]))
  const proposedOf = new Map(proposedPlans.map(p => [p.sessionId, p]))
  const activeOf = new Map(activeRuns.map(r => [r.sessionId, r.id]))
  return rows.map((row) => {
    const last = lastOf.get(row.id)
    const latestConversation = conversationOf.get(row.id)
    const turn = turnOf.get(row.id)
    const proposed = proposedOf.get(row.id)
    const attention: SessionAttention = proposed
      ? { status: 'needs_approval', plan: proposed }
      : latestConversation?.role === 'pm' && latestConversation.kind === 'error'
        ? { status: 'failed', failure: latestConversation }
        : turn?.role === 'pm' && turn.kind === 'question' ? { status: 'question', question: turn } : { status: 'none' }
    const session: PlanSession = {
      id: row.id,
      parentSessionId: row.parentSessionId,
      projectId: row.projectId,
      title: row.title,
      runtime: row.runtime as AgentRuntime,
      preview: last?.text.slice(0, 160) ?? '',
      unread: row.unread,
      closed: row.closedAt !== null,
      status: attention.status,
      activeRunId: activeRunId === undefined ? activeOf.get(row.id) ?? null : activeRunId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }
    return { session, attention }
  })
}

export async function findSession(db: Executor, sessionId: string): Promise<PlanSessionRow> {
  const [row] = await db.select().from(planSessions).where(eq(planSessions.id, sessionId))
  if (!row) throw notFound()
  return row
}

// Tells the web app a session changed: its state, unread flag or running turn
export class PlanSessions {
  #db: Database
  #events: EventBus

  constructor(db: Database, events: EventBus) {
    this.#db = db
    this.#events = events
  }

  async toSession(row: PlanSessionRow, activeRunId?: string | null): Promise<PlanSession> {
    return (await sessionState(this.#db, row, activeRunId)).session
  }

  async publish(sessionId: string, activeRunId?: string | null): Promise<PlanSession> {
    const session = await this.toSession(await findSession(this.#db, sessionId), activeRunId)
    this.#events.publish({ type: 'plan.session', session })
    return session
  }

  // A message the caller's own write saved, once that write has committed
  messageSaved(row: typeof planMessages.$inferSelect): PlanMessage {
    const message = toMessage(row)
    this.#events.publish({ type: 'plan.message', message })
    return message
  }

  // A message outside any other write: saved, published, and the session with it
  async post(sessionId: string, fields: NewPlanMessageFields, links: MessageLinks & { unread: boolean }): Promise<PlanMessage> {
    const { unread, ...rest } = links
    const message = this.messageSaved(await this.#db.transaction(async (tx) => {
      const row = await insertMessage(tx, sessionId, fields, rest)
      if (unread) await touchSession(tx, sessionId, { unread })
      return row
    }))
    await this.publish(sessionId, links.runId)
    return message
  }
}
