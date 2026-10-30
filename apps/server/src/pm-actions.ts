import { requiresPmConfirmation, type PlanMessage } from '@corral/contracts'
import type { Actor, PmAction } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, sql } from 'drizzle-orm'
import { ApiFailure, notFound } from './errors.ts'
import type { EventBus } from './events.ts'
import { toMessage } from './plan.ts'

const { planMessages, planSessions, auditLog, tasks } = schema

export interface PreparedPmAction {
  input: Record<string, unknown>
  summary: string
  // What the action is bound to: a confirmation can't move to another target
  targetId: string | null
  taskId: string | null
  projectId: string
}

interface Deps {
  db: Database
  events: EventBus
  prepare(sessionId: string, tool: string, input: unknown): Promise<PreparedPmAction>
  execute(sessionId: string, tool: string, prepared: PreparedPmAction, actor: Actor): Promise<unknown>
  sessionChanged(sessionId: string): Promise<void>
}

// Every confirm-required tool uses this lifecycle. Its message is also the
// durable pending-action record, so the card survives reloads and restarts.
export class PmActions {
  #d: Deps
  constructor(deps: Deps) { this.#d = deps }

  async recoverInterrupted(): Promise<void> {
    const { db } = this.#d
    const rows = await db.select().from(planMessages).where(sql`${planMessages.pendingAction}->>'status' = 'executing'`)
    for (const row of rows) {
      const error = 'Confirmation was interrupted by a server restart. Check Activity before proposing this action again.'
      await db.transaction(async (tx) => {
        await tx.update(planMessages).set({ pendingAction: { ...row.pendingAction!, status: 'failed', error } }).where(eq(planMessages.id, row.id))
        await tx.insert(planMessages).values({ sessionId: row.sessionId, role: 'pm', kind: 'action_result', text: `${row.pendingAction!.summary}: ${error}` })
        await tx.update(planSessions).set({ unread: true, updatedAt: new Date() }).where(eq(planSessions.id, row.sessionId))
        const [session] = await tx.select().from(planSessions).where(eq(planSessions.id, row.sessionId))
        await tx.insert(auditLog).values({ projectId: session!.projectId, actor: { kind: 'system', component: 'server' }, action: 'pm.action_failed', detail: { actionId: row.id, sessionId: row.sessionId, runId: row.runId, error } })
      })
    }
  }

  async propose(sessionId: string, runId: string, tool: string, input: unknown, actor: Actor) {
    if (!requiresPmConfirmation(tool)) throw new Error(`Not a confirm-required tool: ${tool}`)
    const prepared = await this.#d.prepare(sessionId, tool, input)
    const action: PmAction = { tool, input: prepared.input, summary: prepared.summary.replace(/\s+/g, ' ').trim(), status: 'pending', targetId: prepared.targetId, error: null, result: null }
    const message = await this.#d.db.transaction(async (tx) => {
      const [session] = await tx.select().from(planSessions).where(eq(planSessions.id, sessionId)).for('update')
      if (!session || session.closedAt) throw new Error('This conversation is closed or no longer exists')
      const [row] = await tx.insert(planMessages).values({ sessionId, runId, role: 'pm', kind: 'confirmation', text: action.summary, pendingAction: action }).returning()
      await tx.insert(auditLog).values({ projectId: prepared.projectId, taskId: prepared.taskId, actor, action: 'pm.action_proposed', detail: { actionId: row!.id, sessionId, runId, targetId: action.targetId, tool, input: action.input, summary: action.summary } })
      await tx.update(planSessions).set({ unread: true, updatedAt: new Date() }).where(eq(planSessions.id, sessionId))
      return row!
    })
    this.#d.events.publish({ type: 'plan.message', message: toMessage(message) })
    await this.#d.sessionChanged(sessionId)
    return { confirmationPending: true, actionId: message.id, summary: action.summary, message: 'Confirmation is pending. Nothing has changed. Finish your turn; the human can Confirm or Cancel in the conversation.' }
  }

  async resolve(sessionId: string, actionId: string, decision: 'confirm' | 'cancel', actor: Actor): Promise<PlanMessage> {
    if (actor.kind !== 'human') throw new ApiFailure(403, { code: 'forbidden' })
    const { db, events } = this.#d
    const [row] = await db.select().from(planMessages).where(and(eq(planMessages.id, actionId), eq(planMessages.sessionId, sessionId)))
    if (!row?.pendingAction || !row.runId) throw notFound()
    if (row.pendingAction.status !== 'pending') return toMessage(row)
    const action = { ...row.pendingAction }
    // Claim durably before executing outside a transaction: tools can call
    // services with their own transactions and external effects. A lost HTTP
    // response or a competing click cannot run the action a second time.
    const [claimed] = await db.update(planMessages).set({ pendingAction: { ...action, status: 'executing' } })
      .where(and(eq(planMessages.id, actionId), sql`${planMessages.pendingAction}->>'status' = 'pending'`)).returning()
    if (!claimed) {
      const [current] = await db.select().from(planMessages).where(eq(planMessages.id, actionId))
      if (!current) throw notFound()
      return toMessage(current)
    }
    const [session] = await db.select().from(planSessions).where(eq(planSessions.id, sessionId))
    if (!session) throw notFound()
    const proposer: Actor = { kind: 'agent', role: 'pm', runId: row.runId }
    if (decision === 'cancel') {
      action.status = 'cancelled'
    } else {
      try {
        if (session.closedAt) throw new Error('This conversation is closed')
        if (!requiresPmConfirmation(action.tool)) throw new Error('This tool is no longer available for confirmation')
        const prepared = await this.#d.prepare(sessionId, action.tool, action.input)
        if (prepared.targetId !== action.targetId) throw new Error('The target of this action has changed')
        action.result = await this.#d.execute(sessionId, action.tool, prepared, { ...actor, viaPm: { sessionId, runId: row.runId } })
        action.status = 'confirmed'
      } catch (error) {
        action.status = 'failed'
        action.error = error instanceof ApiFailure ? JSON.stringify(error.body) : error instanceof Error ? error.message : String(error)
      }
    }
    const text = decision === 'cancel'
      ? `Cancelled: ${action.summary}. Nothing was changed.`
      : action.status === 'failed'
        ? `Could not confirm: ${action.summary}. ${action.error}`
        : `Confirmed: ${action.summary}. ${typeof action.result === 'string' ? action.result : JSON.stringify(action.result)}`
    const resolved = await db.transaction(async (tx) => {
      const [target] = action.targetId ? await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, action.targetId)) : []
      // Removing the conversation's own project took the conversation with it
      const [alive] = await tx.select({ id: planSessions.id }).from(planSessions).where(eq(planSessions.id, sessionId))
      const projectId = alive ? session.projectId : null
      const audit = { projectId, taskId: target?.id ?? null, actor, action: decision === 'cancel' ? 'pm.action_cancelled' : action.status === 'confirmed' ? 'pm.action_confirmed' : 'pm.action_failed', detail: { actionId, sessionId, runId: row.runId, targetId: action.targetId, proposer, tool: action.tool, input: action.input, summary: action.summary, result: action.result, error: action.error } }
      await tx.insert(auditLog).values(audit)
      if (!alive) return null
      const [message] = await tx.update(planMessages).set({ pendingAction: action }).where(eq(planMessages.id, actionId)).returning()
      const [result] = await tx.insert(planMessages).values({ sessionId, role: 'pm', kind: 'action_result', text }).returning()
      await tx.update(planSessions).set({ unread: true, updatedAt: new Date() }).where(eq(planSessions.id, sessionId))
      return { message: message!, result: result! }
    })
    if (!resolved) return toMessage({ ...row, pendingAction: action })
    events.publish({ type: 'plan.message', message: toMessage(resolved.message) })
    if (resolved.result) events.publish({ type: 'plan.message', message: toMessage(resolved.result) })
    await this.#d.sessionChanged(sessionId)
    return toMessage(resolved.message)
  }
}
