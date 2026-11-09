import { toolName, type PlanMessage, type PlanSession, type PlanSessionDetail } from '@corral/contracts'
import { ACTIVE_RUN_STATES, clip, DEFAULT_AGENT_RUNTIME, errorText, isDesignPinStale, TASK_STATUS_LABELS, taskRef, type Actor, type AgentRuntime, type TaskStatus } from '@corral/core'
import { schema, type Database, type Executor, type PlanSessionRow, type ProjectRow } from '@corral/db'
import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { pinStaleness } from './designs.ts'
import { ApiFailure, notFound } from './errors.ts'
import type { EventBus } from './events.ts'
import { draftSessions } from './plan-items.ts'
import type { PlanProposals } from './plan-proposals.ts'
import { findSession, insertMessage, sessionState, sessionStates, toMessage, touchSession, type PlanSessions } from './plan-sessions.ts'
import { findPmAgent } from './pm-agent.ts'
import { pmFallbackPrompt, pmPrompt, type PmHistoryMessage } from './prompts.ts'
import { answerRecovery } from './retry-recovery.ts'
import { pmJob, type PendingPmJob } from './run-job.ts'
import type { RunnerHub } from './runner-hub.ts'
import { requireRuntimeCli } from './setup.ts'
import { findTaskByRef } from './task-rows.ts'
import { loadTask, loadTasks } from './task-views.ts'
import { deleteTaskRows } from './tasks.ts'
import { ToolError } from './tool-error.ts'

const { designVersions, planMessages, planSessions, planTasks, plans, projects, runs, taskDesignPins, tasks } = schema

const TITLE_MAX_WORDS = 6
const TITLE_MAX_LENGTH = 60

interface PlanDeps {
  db: Database
  events: EventBus
  runner: RunnerHub
  recoveryReady(taskIds: string[]): void
  stopRun(runId: string, actor: Actor): Promise<void>
  // Starts a PM run for a session; the orchestrator owns runs. The job
  // carries the session's runtime, not the PM agent's (D18).
  startRun(session: PlanSessionRow, job: PendingPmJob): Promise<string>
  sessions: PlanSessions
  proposals: Pick<PlanProposals, 'toPlans' | 'publishDrafts'>
}

// The PM conversation (D9, design/plan.md): sessions, messages and turns.
// Each turn is a runner job with role `pm`, whose tools (pm-tools.ts) are the
// only way it touches the board.
export class PlanService {
  #d: PlanDeps
  #pendingTurns = new Set<string>()

  constructor(deps: PlanDeps) {
    this.#d = deps
  }

  async listSessions(): Promise<PlanSession[]> {
    const rows = await this.#d.db.select().from(planSessions).orderBy(desc(planSessions.updatedAt))
    return (await sessionStates(this.#d.db, rows)).map(s => s.session)
  }

  async getSession(sessionId: string): Promise<PlanSessionDetail> {
    const row = await this.#session(sessionId)
    const messages = await this.#d.db.select().from(planMessages).where(eq(planMessages.sessionId, sessionId)).orderBy(asc(planMessages.createdAt))
    const planRows = await this.#d.db.select().from(plans).where(eq(plans.sessionId, sessionId)).orderBy(asc(plans.version))
    return {
      ...(await this.#toSession(row)),
      messages: messages.map(toMessage),
      plans: await this.#d.proposals.toPlans(planRows)
    }
  }

  async markRead(sessionId: string): Promise<PlanSession> {
    await this.#d.db.update(planSessions).set({ unread: false }).where(eq(planSessions.id, sessionId))
    const session = await this.#toSession(await this.#session(sessionId))
    this.#d.events.publish({ type: 'plan.session', session, markedRead: true })
    return session
  }

  // Stop the turn before discarding anything, so its fenced tools cannot
  // create more drafts after the thread closes.
  async close(sessionId: string, actor: Actor): Promise<PlanSession> {
    const { db, events } = this.#d
    const session = await this.#session(sessionId)
    if (session.closedAt) return this.#toSession(session)
    await this.#assertCloseAllowed(db, sessionId, actor)
    const stopTurns = async () => {
      const active = await db.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.planSessionId, sessionId), eq(runs.role, 'pm'), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      for (const run of active) await this.#d.stopRun(run.id, actor)
    }
    await stopTurns()
    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(planSessions).where(eq(planSessions.id, sessionId)).for('update')
      if (locked!.closedAt) return null
      await this.#assertCloseAllowed(tx, sessionId, actor)
      const drafts = await tx.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks)
        .where(and(eq(tasks.status, 'draft'), isNull(tasks.deletedAt), inArray(tasks.id, tx.select({ id: planTasks.taskId }).from(planTasks)
          .innerJoin(plans, eq(plans.id, planTasks.planId)).where(eq(plans.sessionId, sessionId))))).for('update')
      const owners = await draftSessions(tx, drafts.map(t => t.id))
      const owned = drafts.filter(t => owners.get(t.id)?.id === sessionId)
      const detached = new Set<string>()
      for (const task of owned) {
        for (const id of await deleteTaskRows(tx, task.id, actor, 'Discarded with the Plan thread', { discardDraft: true })) detached.add(id)
      }
      await tx.update(plans).set({ status: 'discarded' })
        .where(and(eq(plans.sessionId, sessionId), eq(plans.status, 'proposed'), isNull(plans.approvedAt)))
      const now = new Date()
      await tx.update(planSessions).set({ closedAt: now, updatedAt: now, unread: false }).where(eq(planSessions.id, sessionId))
      return { owned, detached: [...detached].filter(id => !owned.some(t => t.id === id)) }
    })
    // Catch a turn inserted between the first stop and the session lock.
    // startPmRun's same lock now refuses every insertion after close.
    await stopTurns()
    const closed = await this.#toSession(await this.#session(sessionId))
    if (deleted) {
      for (const task of deleted.owned) events.publish({ type: 'task.deleted', taskId: task.id, projectId: task.projectId })
      for (const task of await loadTasks(db, deleted.detached)) events.publish({ type: 'task.updated', task })
      const discarded = await db.select().from(plans).where(and(eq(plans.sessionId, sessionId), eq(plans.status, 'discarded')))
      for (const plan of await this.#d.proposals.toPlans(discarded)) events.publish({ type: 'plan.updated', plan })
      events.publish({ type: 'plan.session', session: closed })
      for (const projectId of new Set(deleted.owned.map(t => t.projectId))) await this.#d.proposals.publishDrafts(projectId)
    }
    return closed
  }

  // An agent may stop an empty thread, but discarding human-owned work
  // requires the human's confirmed close flow (D11/D30).
  async #assertCloseAllowed(db: Executor, sessionId: string, actor: Actor): Promise<void> {
    if (actor.kind === 'human') return
    const [proposed] = await db.select({ id: plans.id }).from(plans)
      .where(and(eq(plans.sessionId, sessionId), eq(plans.status, 'proposed'))).limit(1)
    const drafts = await db.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.status, 'draft'), isNull(tasks.deletedAt), inArray(tasks.id, db.select({ id: planTasks.taskId }).from(planTasks)
        .innerJoin(plans, eq(plans.id, planTasks.planId)).where(eq(plans.sessionId, sessionId)))))
    const owners = await draftSessions(db, drafts.map(t => t.id))
    if (proposed || drafts.some(t => owners.get(t.id)?.id === sessionId)) {
      throw new ToolError('This thread has a proposed plan or owned Drafts. Ask the human to close it using Close thread and confirm the discard; agents cannot discard this work.')
    }
  }

  // design/plan.md: the project and runtime are locked once the session has messages
  async start(projectId: string | null, input: { id?: string | undefined, text: string, taskRef?: string | undefined, runtime?: AgentRuntime, title?: string, parentSessionId?: string }, actor: Actor): Promise<PlanSessionDetail> {
    this.assertTurnPossible()
    const { db, events } = this.#d
    // A retry returns the original thread without interpreting a new message.
    if (input.id) {
      const [existing] = await db.select().from(planSessions).where(eq(planSessions.id, input.id))
      if (existing) return this.#retryStart(existing, projectId)
    }
    const [project] = projectId ? await db.select().from(projects).where(eq(projects.id, projectId)) : []
    if (projectId && !project) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['projectId'], message: 'Unknown project' }] })
    await requireRuntimeCli(this.#d.runner, input.runtime ?? DEFAULT_AGENT_RUNTIME)
    this.assertTurnPossible()
    const attached = await this.#attached(project, input.taskRef)
    const text = input.text || `Refine ${attached}`
    const sender = input.parentSessionId ? await this.#session(input.parentSessionId) : null
    const fallback = input.title ?? titleFrom(input.text || `Refine ${input.taskRef}`)
    const created = await db.transaction(async (tx) => {
      this.assertTurnPossible()
      const [session] = await tx.insert(planSessions).values({ ...(input.id ? { id: input.id } : {}), projectId, title: fallback, parentSessionId: sender?.id ?? null, runtime: input.runtime ?? DEFAULT_AGENT_RUNTIME, createdBy: actor })
        .onConflictDoNothing({ target: planSessions.id }).returning()
      if (!session) return null
      const message = await insertMessage(tx, session.id, { role: sender ? 'thread' : 'human', kind: 'message', text }, { senderSessionId: sender?.id ?? null, senderTitle: sender?.title ?? null })
      await appendAudit(tx, { projectId, actor }, auditEvent('plan.message', { sessionId: session.id, messageId: message!.id }))
      return { session, message: message! }
    })
    if (!created) return this.#retryStart(await this.#session(input.id!), projectId)
    const { session, message } = created
    this.#pendingTurns.add(session.id)
    const detail = await this.getSession(session.id)
    events.publish({ type: 'plan.session', session: detail })
    this.#d.sessions.messageSaved(message)
    // Leave the response independent of runner/orchestrator work, including
    // synchronous failures. The durable message remains the turn's record.
    setImmediate(() => {
      void this.#queueInitialTurn(session, project, sender ? threadText(sender, text) : text, attached).catch(error => console.error(`Recording failed PM turn for ${session.id} failed`, error)).finally(() => this.#pendingTurns.delete(session.id))
      if (!input.title) void this.#generateTitle(session.id, fallback, { text, attachedTask: attached })
    })
    return detail
  }

  async #retryStart(session: PlanSessionRow, projectId: string | null): Promise<PlanSessionDetail> {
    if (session.projectId !== projectId) throw new ApiFailure(409, { code: 'conflict', constraint: 'plan_session_project' })
    return this.getSession(session.id)
  }

  async #queueInitialTurn(session: PlanSessionRow, project: ProjectRow | undefined, text: string, attached: string | null): Promise<void> {
    try {
      await this.#turn(session, project, { text, attributed: text, attached, fresh: true })
    } catch (error) {
      if ((await this.#session(session.id)).closedAt) return
      await this.#d.sessions.post(session.id, { role: 'pm', kind: 'error', text: `Could not queue the PM turn: ${errorText(error)}` }, { unread: true })
    }
  }

  // Replaces the fallback title with one from the runner's smallest model
  // (COR-40). It's a setup job, not a run, so it holds no PM slot. On any
  // failure the fallback stays. A title that's no longer the fallback was
  // changed by someone else and is kept.
  async #generateTitle(sessionId: string, fallback: string, input: { text: string, attachedTask: string | null }): Promise<void> {
    try {
      const result = await this.#d.runner.request({ kind: 'session_title', prompt: sessionTitlePrompt(input) })
      const title = cleanSessionTitle(result.title)
      if (!title) throw new Error(`Unusable title "${result.title}"`)
      const [updated] = await this.#d.db.update(planSessions).set({ title })
        .where(and(eq(planSessions.id, sessionId), eq(planSessions.title, fallback))).returning()
      if (updated) await this.#d.sessions.publish(sessionId)
    } catch (error) {
      console.error(`Generating a title for Plan session ${sessionId} failed; keeping "${fallback}"`, error instanceof Error ? error.message : error)
    }
  }

  // A session's runtime can only change while it has no messages, since an
  // agent session ID only resumes on the vendor that made it (D18)
  async setRuntime(sessionId: string, runtime: AgentRuntime, actor: Actor): Promise<PlanSession> {
    const { db } = this.#d
    const session = await this.#session(sessionId)
    if (session.runtime !== runtime) {
      const [message] = await db.select({ id: planMessages.id }).from(planMessages).where(eq(planMessages.sessionId, sessionId)).limit(1)
      if (message || session.agentSessionId) throw new ApiFailure(409, { code: 'conflict', constraint: 'plan_session_runtime_locked' })
      await db.update(planSessions).set({ runtime, updatedAt: new Date() }).where(eq(planSessions.id, sessionId))
      await appendAudit(db, { projectId: session.projectId, actor }, auditEvent('plan.runtime', { sessionId, from: session.runtime, to: runtime }))
    }
    return this.#d.sessions.publish(sessionId)
  }

  // A turn needs the runner; update holds queue it in the orchestrator (D16)
  assertTurnPossible(): void {
    if (!this.#d.runner.online) throw new ApiFailure(503, { code: 'runner_offline' })
  }

  // Approving a design version opens a Plan session for its build, with the
  // human's message (D20). One per version: approving it again opens none,
  // and only sends the message if it never went out. Returns the session.
  async startDesignBuild(versionId: string, note: string | undefined, actor: Actor): Promise<string> {
    const { db } = this.#d
    const [row] = await db.select({ version: designVersions.version, task: tasks, project: projects }).from(designVersions)
      .innerJoin(tasks, eq(tasks.id, designVersions.taskId)).innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(designVersions.id, versionId))
    if (!row) throw notFound()
    const sessionId = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ planSessionId: designVersions.planSessionId }).from(designVersions)
        .where(eq(designVersions.id, versionId)).for('update')
      if (locked?.planSessionId) return locked.planSessionId
      const pm = await findPmAgent(tx)
      const [session] = await tx.insert(planSessions).values({
        projectId: row.project.id, title: `Build: ${row.task.title}`, runtime: pm?.runtime ?? DEFAULT_AGENT_RUNTIME, createdBy: actor
      }).returning()
      await tx.update(designVersions).set({ planSessionId: session!.id, updatedAt: new Date() }).where(eq(designVersions.id, versionId))
      return session!.id
    })
    const [sent] = await db.select({ id: planMessages.id }).from(planMessages).where(eq(planMessages.sessionId, sessionId)).limit(1)
    if (!sent) {
      const ref = taskRef(row.project.prefix, row.task.number)
      const stale = await this.#staleBuildTasks(row.project.prefix, row.task.id)
      await this.message(sessionId, { text: designBuildMessage(ref, row.task.title, row.version, note, stale), taskRef: ref }, actor)
    }
    return sessionId
  }

  // The build tasks still pinned to an older version of the design that
  // haven't started (D20): approving a newer version flags them
  async #staleBuildTasks(prefix: string, designTaskId: string): Promise<{ ref: string, title: string, status: TaskStatus, version: number }[]> {
    const { db } = this.#d
    const pinned = await db.select({ id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status, version: designVersions.version })
      .from(taskDesignPins).innerJoin(designVersions, eq(designVersions.id, taskDesignPins.designVersionId)).innerJoin(tasks, eq(tasks.id, taskDesignPins.taskId))
      .where(and(eq(designVersions.taskId, designTaskId), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
    const { latestApproved, started } = await pinStaleness(db, [designTaskId], pinned.map(p => p.id))
    return pinned
      .filter(p => isDesignPinStale({ version: p.version, latestApproved: latestApproved.get(designTaskId) ?? null }, { status: p.status, started: started.has(p.id) }))
      .map(p => ({ ref: taskRef(prefix, p.number), title: p.title, status: p.status, version: p.version }))
  }

  // A human message starts one PM turn (D9)
  async message(sessionId: string, input: { text: string, taskRef?: string | undefined, senderSessionId?: string }, actor: Actor): Promise<PlanMessage> {
    const { db } = this.#d
    const session = await this.#session(sessionId)
    const [project] = session.projectId ? await db.select().from(projects).where(eq(projects.id, session.projectId)) : []
    if (session.projectId && !project) throw notFound()
    this.assertTurnPossible()
    // One turn at a time per session; other sessions, in this project or
    // another, aren't held back, since the PM has no concurrency (D9, D13)
    const [active] = await db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.role, 'pm'), eq(runs.planSessionId, sessionId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    if (active || this.#pendingTurns.has(sessionId)) throw new ApiFailure(409, { code: 'conflict', constraint: 'pm_turn_in_progress' })

    const attached = await this.#attached(project, input.taskRef)
    const [previousInput] = await db.select({ createdAt: planMessages.createdAt }).from(planMessages)
      .where(and(eq(planMessages.sessionId, sessionId), inArray(planMessages.role, ['human', 'thread']), eq(planMessages.kind, 'message')))
      .orderBy(desc(planMessages.createdAt)).limit(1)
    const text = input.text || `Refine ${attached}`
    const pending = (await sessionState(db, session)).attention
    const sender = input.senderSessionId ? await this.#session(input.senderSessionId) : null
    const message = await insertMessage(db, sessionId, { role: sender ? 'thread' : 'human', kind: 'message', text }, { senderSessionId: sender?.id ?? null, senderTitle: sender?.title ?? null })
    // A new message reopens a session closed by approving its plan
    await db.update(planSessions).set({ updatedAt: new Date(), unread: false, closedAt: null }).where(eq(planSessions.id, sessionId))
    await appendAudit(db, { projectId: session.projectId, actor }, auditEvent('plan.message', { sessionId, messageId: message!.id }))
    this.#d.sessions.messageSaved(message)
    const recovered = await answerRecovery(db, this.#d.events, sessionId, text, actor, !session.closedAt && pending.status === 'question' ? pending.question.id : null)
    if (recovered.length) this.#d.recoveryReady(recovered)

    // Warm agent sessions do not replay database history. Include the saved
    // confirmation ledger in full, plus notices since the preceding input.
    // The current input is already saved, so notices racing this query remain
    // after its timestamp and are delivered with the next turn.
    const results = await db.select().from(planMessages)
      .where(and(eq(planMessages.sessionId, sessionId), or(
        eq(planMessages.kind, 'action_result'),
        and(eq(planMessages.kind, 'notification'), lte(planMessages.createdAt, message!.createdAt), previousInput ? gt(planMessages.createdAt, previousInput.createdAt) : undefined)
      )))
      .orderBy(asc(planMessages.createdAt))
    const attributedText = sender ? threadText(sender, text) : text
    const turnText = results.length ? `${attributedText}\n\nRecorded tool results and thread notifications:\n${results.map(r => r.role === 'thread' ? threadText({ id: r.senderSessionId ?? 'removed', title: r.senderTitle ?? 'Removed thread' }, r.text) : r.text).join('\n')}` : attributedText
    await this.#turn(session, project, { text: turnText, attributed: attributedText, attached, fresh: session.agentSessionId === null })
    return toMessage(message)
  }

  // The task a message is about, as the prompt names it
  async #attached(project: ProjectRow | undefined, ref: string | undefined): Promise<string | null> {
    if (!ref) return null
    if (!project) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['taskRef'], message: 'Choose a project to attach a task' }] })
    const task = await loadTask(this.#d.db, (await findTaskByRef(this.#d.db, project, ref)).id)
    return `${task.ref} ${task.title}`
  }

  // A turn for the message `text`. A lost agent session is reseeded with the
  // conversation so far and the message as sent (`attributed`), without the
  // notices a warm session gets.
  async #turn(session: PlanSessionRow, project: ProjectRow | undefined, turn: { text: string, attributed: string, attached: string | null, fresh: boolean }): Promise<void> {
    const about = { attachedTask: turn.attached, projectName: project?.name ?? null, prefix: project?.prefix ?? null }
    const runId = await this.#d.startRun(session, pmJob(session, project ?? null, {
      prompt: pmPrompt({ ...about, text: turn.text, fresh: turn.fresh }),
      fallbackPrompt: pmFallbackPrompt({ ...about, text: turn.attributed, history: await this.#history(session.id) })
    }))
    await this.#d.sessions.publish(session.id, runId)
  }

  async onRunStarted(sessionId: string, agentSessionId: string | null): Promise<void> {
    if (agentSessionId) await this.#d.db.update(planSessions).set({ agentSessionId }).where(eq(planSessions.id, sessionId))
  }

  // The PM's reply is what it said last; it's saved from the transcript so
  // the database, not the CLI's session, is the record (D9)
  async onRunEnded(sessionId: string, runId: string, reply: string | null, error: string | null): Promise<void> {
    const { db } = this.#d
    if (reply?.trim()) {
      // A run.ended replayed after reconnecting may bring what's already saved
      const [saved] = await db.select({ id: planMessages.id }).from(planMessages)
        .where(and(eq(planMessages.runId, runId), eq(planMessages.kind, 'message'), eq(planMessages.text, reply.trim()))).limit(1)
      if (saved) return
      this.#d.sessions.messageSaved(await insertMessage(db, sessionId, { role: 'pm', kind: 'message', text: reply.trim() }, { runId }))
    } else if (error) {
      this.#d.sessions.messageSaved(await insertMessage(db, sessionId, { role: 'pm', kind: 'error', text: error }, { runId }))
    }
    // Every finished turn (reply, question or plan) waits for the human to read it
    await touchSession(db, sessionId, { unread: true })
    await this.#d.sessions.publish(sessionId, null)
    await this.notifyParent(sessionId, runId, false, Boolean(error))
  }

  // Stop paths fence the run before its eventual runner exit, so they must
  // notify here rather than waiting for onRunEnded. One notice per child run.
  async notifyParent(sessionId: string, runId: string, stopped = false, error = false): Promise<void> {
    const { db } = this.#d
    const child = await this.#session(sessionId)
    if (!child.parentSessionId) return
    const notification = await db.transaction(async (tx) => {
      await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for('update')
      const [existing] = await tx.select({ id: planMessages.id }).from(planMessages)
        .where(and(eq(planMessages.sessionId, child.parentSessionId!), eq(planMessages.runId, runId), eq(planMessages.kind, 'notification'))).limit(1)
      if (existing) return null
      const message = await insertMessage(tx, child.parentSessionId!, {
        role: 'thread', kind: 'notification',
        text: `Thread “${child.title}” ${stopped ? 'was stopped' : `finished its turn${error ? ' with an error' : ''}`}.`
      }, { runId, senderSessionId: child.id, senderTitle: child.title })
      // Child activity isn't a new PM reply waiting for the human (D11).
      await touchSession(tx, child.parentSessionId!, { unread: false })
      return message
    })
    if (notification) {
      this.#d.sessions.messageSaved(notification)
      await this.#d.sessions.publish(child.parentSessionId)
    }
  }

  #session(sessionId: string): Promise<PlanSessionRow> {
    return findSession(this.#d.db, sessionId)
  }

  // The conversation so far, for reseeding a lost session (D9)
  #history(sessionId: string): Promise<PmHistoryMessage[]> {
    return this.#d.db.select().from(planMessages).where(eq(planMessages.sessionId, sessionId)).orderBy(asc(planMessages.createdAt))
  }

  #toSession(row: PlanSessionRow): Promise<PlanSession> {
    return this.#d.sessions.toSession(row)
  }
}

// The runner's smallest model titles a new Plan session from its first
// message (COR-40). The answer is cleaned up by `cleanSessionTitle`.
function sessionTitlePrompt(input: { text: string, attachedTask: string | null }): string {
  return [
    `Write a title for a planning conversation that starts with the message below. Use at most ${TITLE_MAX_WORDS} words, in sentence case. Reply with the title only: no quotes, no punctuation at the end, nothing else.`,
    input.attachedTask ? `Attached task: ${input.attachedTask}` : '',
    `Message:\n${input.text.slice(0, 4000)}`
  ].filter(Boolean).join('\n\n')
}

// The model's answer as a title: its first line without quotes, a "Title:"
// label or end punctuation, at most 6 words and 60 characters. Null when
// nothing is left.
export function cleanSessionTitle(raw: string): string | null {
  const line = raw.split('\n').map(l => l.trim()).find(Boolean) ?? ''
  const words = line
    .replace(/^#+\s*/, '')
    .replace(/["“”`*]/g, '')
    .replace(/^title\s*:\s*/i, '')
    .split(/\s+/)
    .map(word => word.replace(/^['‘’]+|['‘’]+$/g, ''))
    .filter(Boolean).slice(0, TITLE_MAX_WORDS)
  while (words.join(' ').length > TITLE_MAX_LENGTH && words.length > 1) words.pop()
  return words.join(' ').slice(0, TITLE_MAX_LENGTH).replace(/[\s.!?:;,]+$/, '') || null
}

function titleFrom(text: string): string {
  const line = text.split('\n')[0]!.trim()
  return clip(line, TITLE_MAX_LENGTH) || 'New session'
}

// The human's first message in a design's build session (D20)
// A newer version also lists the unstarted build tasks pinned to an older
// one, so the PM can propose revisions that repin them.
function designBuildMessage(ref: string, title: string, version: number, note: string | undefined, stale: { ref: string, title: string, status: TaskStatus, version: number }[] = []): string {
  const ask = `I approved design v${version} of ${ref} "${title}". Plan its build: read it with ${toolName('get_design')} (taskRef ${ref}, version ${version}) and propose the build tasks, each pinned to v${version} and the screens it covers.`
  const flagged = stale.length > 0
    ? `These build tasks haven't started and are pinned to an older version, so they're flagged as design changed. Compare their screens with v${version} and propose revisions (include each with its \`ref\`) that repin them to v${version} and update what changed; don't create duplicates of them:\n${stale.map(t => `- ${t.ref} "${t.title}" (${TASK_STATUS_LABELS[t.status]}): pinned to v${t.version}, design changed: v${t.version} → v${version}`).join('\n')}`
    : ''
  return [ask, flagged, note ? `Approval note: ${note}` : ''].filter(Boolean).join('\n\n')
}

function threadText(sender: { id: string, title: string }, text: string): string {
  return `Message from PM thread “${sender.title}” (${sender.id}), not from the human:\n${text}`
}
