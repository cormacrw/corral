import { neutralPmCall, type PlanMessage, type PmActionDecision } from '@corral/contracts'
import { SERVER_ACTOR, type Actor, type PmAction } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, sql } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { failureReason, notFound, requireHuman } from './errors.ts'
import type { EventBus } from './events.ts'
import { insertMessage, toMessage, touchSession, type PlanSessions } from './plan-sessions.ts'
import type { PmTools, PreparedPmAction } from './pm-tools.ts'

const { planMessages, planSessions, projects, tasks } = schema

interface Deps {
  db: Database
  events: EventBus
  sessions: Pick<PlanSessions, 'publish' | 'messageSaved'>
  tools: Pick<PmTools, 'prepare' | 'execute'>
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// What a card agreed to, whichever names it was saved under
const neutralSummary = (summary: string) => summary.replaceAll(/\bepicId\b/g, 'parentId').replaceAll(/\b(?:epic|parent)\b/g, 'task')

// Every confirm card's lifecycle. Its message is also the durable
// pending-action record, so the card survives reloads and restarts.
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
        await insertMessage(tx, row.sessionId, { role: 'pm', kind: 'action_result', text: `${row.pendingAction!.summary}: ${error}` })
        await touchSession(tx, row.sessionId, { unread: true })
        const [session] = await tx.select().from(planSessions).where(eq(planSessions.id, row.sessionId))
        await appendAudit(tx, { projectId: session!.projectId, actor: SERVER_ACTOR }, auditEvent('pm.action_failed', { actionId: row.id, sessionId: row.sessionId, runId: row.runId, error }))
      })
    }
  }

  async propose(sessionId: string, runId: string, tool: string, prepared: PreparedPmAction, actor: Actor) {
    const action: PmAction = { tool, input: prepared.input, summary: oneLine(prepared.summary), status: 'pending', targetId: prepared.targetId, error: null, result: null }
    const message = await this.#d.db.transaction(async (tx) => {
      const [session] = await tx.select().from(planSessions).where(eq(planSessions.id, sessionId)).for('update')
      if (!session || session.closedAt) throw new Error('This conversation is closed or no longer exists')
      const row = await insertMessage(tx, sessionId, { role: 'pm', kind: 'confirmation', text: action.summary }, { runId, pendingAction: action })
      await appendAudit(tx, { projectId: prepared.projectId, taskId: prepared.taskId, actor }, auditEvent('pm.action_proposed', { actionId: row.id, sessionId, runId, targetId: action.targetId, tool, input: action.input, summary: action.summary }))
      await touchSession(tx, sessionId, { unread: true })
      return row
    })
    this.#d.sessions.messageSaved(message)
    await this.#d.sessions.publish(sessionId)
    return { confirmationPending: true, actionId: message.id, summary: action.summary, message: 'Confirmation is pending. Nothing has changed. Finish your turn; the human can Confirm or Cancel in the conversation.' }
  }

  async resolve(sessionId: string, actionId: string, decision: PmActionDecision, actor: Actor): Promise<PlanMessage> {
    requireHuman(actor)
    const { db } = this.#d
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
    // A hard-deleted target can't name its project afterwards, and a global
    // session has none of its own
    let actionProjectId = session.projectId
    if (decision === 'cancel') {
      action.status = 'cancelled'
    } else {
      try {
        if (session.closedAt) throw new Error('This conversation is closed')
        // A card saved before D31 keeps its old names
        const { tool, input } = neutralPmCall(action.tool, action.input)
        const prepared = await this.#d.tools.prepare(sessionId, row.runId, tool, input)
        actionProjectId = prepared.projectId
        // The summary is what the human agreed to, so it also catches a task
        // that moved on and came back, such as a new head on a reviewed PR.
        if (prepared.targetId !== action.targetId || neutralSummary(oneLine(prepared.summary)) !== neutralSummary(action.summary)) throw new Error('The target of this action has changed')
        action.result = await this.#d.tools.execute(sessionId, row.runId, tool, prepared, { ...actor, viaPm: { sessionId, runId: row.runId } })
        action.status = 'confirmed'
      } catch (error) {
        action.status = 'failed'
        action.error = failureReason(error)
      }
    }
    const text = decision === 'cancel'
      ? `Cancelled: ${action.summary}. Nothing was changed.`
      : action.status === 'failed'
        ? `Could not confirm: ${action.summary}. ${action.error}`
        : `Confirmed: ${action.summary}. ${typeof action.result === 'string' ? action.result : JSON.stringify(action.result)}`
    const resolved = await db.transaction(async (tx) => {
      const [target] = action.targetId ? await tx.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, action.targetId)) : []
      // Removing the conversation's own project took the conversation with it
      const [alive] = await tx.select({ id: planSessions.id }).from(planSessions).where(eq(planSessions.id, sessionId))
      const [owner] = actionProjectId ? await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, actionProjectId)) : []
      const projectId = target?.projectId ?? owner?.id ?? (alive ? session.projectId : null)
      const detail = { actionId, sessionId, runId: row.runId, targetId: action.targetId, proposer, tool: action.tool, input: action.input, summary: action.summary, result: action.result, error: action.error }
      await appendAudit(tx, { projectId, taskId: target?.id ?? null, actor }, decision === 'cancel' ? auditEvent('pm.action_cancelled', detail) : action.status === 'confirmed' ? auditEvent('pm.action_confirmed', detail) : auditEvent('pm.action_failed', detail))
      if (!alive) return null
      const [message] = await tx.update(planMessages).set({ pendingAction: action }).where(eq(planMessages.id, actionId)).returning()
      const result = await insertMessage(tx, sessionId, { role: 'pm', kind: 'action_result', text })
      await touchSession(tx, sessionId, { unread: true })
      return { message: message!, result }
    })
    if (!resolved) return toMessage({ ...row, pendingAction: action })
    const message = this.#d.sessions.messageSaved(resolved.message)
    this.#d.sessions.messageSaved(resolved.result)
    await this.#d.sessions.publish(sessionId)
    return message
  }
}
