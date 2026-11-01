import { askQuestionInput, planMessageFields, type NewPlanMessageFields, listTasksInput, normalizeProposedPlan, proposedPlanInput, type AgentRuntime, type DraftSession, type Plan, type PlanMessage, type PlanSession, type PlanSessionDetail, type PmRunJob } from '@corral/contracts'
import { approvedPlanSummary, checkPlan, checkPlanEpicDependencies, designPinKey, diffPlans, isDesignPinStale, markdownToRichText, revisionProblem, richTextToMarkdown, taskRef, type Actor, type DesignPin, type DesignPinTarget, type PlanDependencyContext, type PlanRef, type ProposedPlan, type ProposedTask } from '@corral/core'
import { schema, type Database, type Executor, type PlanRevision } from '@corral/db'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { appendAudit, auditEvent, auditText } from './audit.ts'
import { agentActivity, UnknownAgent } from './agent-activity.ts'
import { listTaskAttachments } from './attachments.ts'
import { publishInvalidatedEpics, type InvalidatedEpics } from './epic-review-state.ts'
import { listEpics, replaceEpicDependencies } from './epics.ts'
import { ApiFailure, notFound } from './errors.ts'
import type { EventBus } from './events.ts'
import { pmFallbackPrompt, pmPrompt, questionText, sessionTitlePrompt } from './prompts.ts'
import type { RunnerHub } from './runner-hub.ts'
import { requireRuntimeCli } from './setup.ts'
import { addComment, createTask, deleteTaskRows, draftSessions, findTaskByRef, loadTask, loadTasks, patchTask, pinStaleness, setDesignPin, transitionTask, type ProjectRow } from './tasks.ts'

const { acceptanceCriteria, agents, auditLog, designVersions, epicDependencies, epics, planEpics, planMessages, planSessions, planTasks, plans, projects, runs, taskDependencies, taskDesignPins, tasks } = schema

const PM_TURN_TIMEOUT_SECONDS = 20 * 60
// The runner gives `claude` 30 s to write a title; this covers the round trip
const TITLE_TIMEOUT_MS = 40_000
const TITLE_MAX_WORDS = 6
const TITLE_MAX_LENGTH = 60

// Thrown back to the PM as a tool error
class ToolError extends Error {}

const ONLY_EPIC = 'main'
const REF = /^([A-Za-z]+)-(\d+)$/

// An existing task a plan names by ref
interface RefTarget {
  id: string
  number: number
  status: string
}

type SessionRow = typeof planSessions.$inferSelect
type PlanRow = typeof plans.$inferSelect

// Commands describe new writes, independently of nullable historical reads.
export interface ApprovePlanCommand {
  approvedBy: Extract<Actor, { kind: 'human' }>
  approvedAt: Date
}

export type PlanTaskWrite = {
  planId: string
  key: string
  position: number
} & (
  | { change: 'added' | 'changed' | 'unchanged', taskId: string, revision: PlanRevision | null }
  | { change: 'removed', taskId: string | null, revision?: null }
)

async function recordApproval(tx: Executor, planId: string, command: ApprovePlanCommand) {
  await tx.update(plans).set({ status: 'approved', ...command }).where(eq(plans.id, planId))
}

async function insertPlanTasks(tx: Executor, items: PlanTaskWrite[]) {
  await tx.insert(planTasks).values(items)
}

export interface PlanDeps {
  db: Database
  events: EventBus
  runner: RunnerHub
  stopRun(runId: string, actor: Actor): Promise<void>
  // Starts a PM run for a session; the orchestrator owns runs. The job
  // carries the session's runtime, not the PM agent's (D18).
  startRun(session: SessionRow, job: Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch'>): Promise<string>
}

// The PM conversation (D9, design/plan.md). Each turn is a runner job with
// role `pm`; the PM's tools here are the only way it touches the board, and
// none of them approve, merge or change status.
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
      plans: await this.toPlans(planRows)
    }
  }

  // A project's Drafts grouped by the Plan session they belong to, newest
  // session first (D10)
  async listDrafts(projectId: string): Promise<DraftSession[]> {
    const { db } = this.#d
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
    if (!project) throw notFound()
    const rows = await db.select().from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.status, 'draft'), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
    const owners = await draftSessions(db, rows.map(r => r.id))
    const sessionIds = [...new Set([...owners.values()].map(o => o.id))]
    if (sessionIds.length === 0) return []
    const sessionRows = await db.select().from(planSessions).where(inArray(planSessions.id, sessionIds)).orderBy(desc(planSessions.updatedAt), desc(planSessions.createdAt))
    // Newest version first, so the first row per session is its latest plan
    const planRows = await db.select({ sessionId: plans.sessionId, status: plans.status }).from(plans)
      .where(inArray(plans.sessionId, sessionIds)).orderBy(desc(plans.version))
    return sessionRows.map(session => ({
      sessionId: session.id,
      title: session.title,
      updatedAt: session.updatedAt.toISOString(),
      planStatus: planRows.find(p => p.sessionId === session.id)?.status ?? null,
      drafts: rows.filter(r => owners.get(r.id)?.id === session.id).map(r => ({
        taskId: r.id, ref: taskRef(project.prefix, r.number), title: r.title, type: r.type, priority: r.priority
      }))
    }))
  }

  async #publishDrafts(projectId: string): Promise<void> {
    this.#d.events.publish({ type: 'plan.drafts', projectId, sessions: await this.listDrafts(projectId) })
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
    const active = await db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.planSessionId, sessionId), eq(runs.role, 'pm'), inArray(runs.state, ['queued', 'starting', 'running', 'stopping'])))
    for (const run of active) await this.#d.stopRun(run.id, actor)
    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(planSessions).where(eq(planSessions.id, sessionId)).for('update')
      if (locked!.closedAt) return null
      const drafts = await tx.select({ id: tasks.id }).from(tasks)
        .where(and(eq(tasks.projectId, session.projectId), eq(tasks.status, 'draft'), isNull(tasks.deletedAt))).for('update')
      const owners = await draftSessions(tx, drafts.map(t => t.id))
      const owned = drafts.filter(t => owners.get(t.id)?.id === sessionId)
      const detached = new Set<string>()
      for (const task of owned) {
        for (const id of await deleteTaskRows(tx, task.id, actor, 'Discarded with the Plan thread', { soft: true, detachDependents: true })) detached.add(id)
      }
      await tx.update(plans).set({ status: 'discarded' })
        .where(and(eq(plans.sessionId, sessionId), eq(plans.status, 'proposed'), isNull(plans.approvedAt)))
      const now = new Date()
      await tx.update(planSessions).set({ closedAt: now, updatedAt: now, unread: false }).where(eq(planSessions.id, sessionId))
      return { owned, detached: [...detached].filter(id => !owned.some(t => t.id === id)) }
    })
    const closed = await this.#toSession(await this.#session(sessionId))
    if (deleted) {
      for (const task of deleted.owned) events.publish({ type: 'task.deleted', taskId: task.id, projectId: session.projectId })
      for (const task of await loadTasks(db, deleted.detached)) events.publish({ type: 'task.updated', task })
      const discarded = await db.select().from(plans).where(and(eq(plans.sessionId, sessionId), eq(plans.status, 'discarded')))
      for (const plan of await this.toPlans(discarded)) events.publish({ type: 'plan.updated', plan })
      events.publish({ type: 'plan.session', session: closed })
      await this.#publishDrafts(session.projectId)
    }
    return closed
  }

  // design/plan.md: the project and runtime are locked once the session has messages
  async start(projectId: string, input: { id?: string | undefined, text: string, taskRef?: string | undefined, runtime?: AgentRuntime }, actor: Actor): Promise<PlanSessionDetail> {
    this.assertTurnPossible()
    const { db, events } = this.#d
    // A retry returns the original thread without interpreting a new message.
    if (input.id) {
      const [existing] = await db.select().from(planSessions).where(eq(planSessions.id, input.id))
      if (existing) return this.#retryStart(existing, projectId)
    }
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
    if (!project) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['projectId'], message: 'Unknown project' }] })
    let attached: string | null = null
    await requireRuntimeCli(this.#d.runner, input.runtime ?? 'claude-code')
    this.assertTurnPossible()
    if (input.taskRef) {
      const task = await loadTask(db, await this.#taskIdByRef(project, input.taskRef))
      attached = `${task.ref} ${task.title}`
    }
    const text = input.text || `Refine ${attached}`
    const fallback = titleFrom(input.text || `Refine ${input.taskRef}`)
    const created = await db.transaction(async (tx) => {
      this.assertTurnPossible()
      const [session] = await tx.insert(planSessions).values({ ...(input.id ? { id: input.id } : {}), projectId, title: fallback, runtime: input.runtime ?? 'claude-code', createdBy: actor })
        .onConflictDoNothing({ target: planSessions.id }).returning()
      if (!session) return null
      const message = await insertMessage(tx, session.id, { role: 'human', kind: 'message', text })
      await appendAudit(tx, { projectId, actor }, auditEvent('plan.message', { sessionId: session.id, messageId: message!.id }))
      return { session, message: message! }
    })
    if (!created) return this.#retryStart(await this.#session(input.id!), projectId)
    const { session, message } = created
    this.#pendingTurns.add(session.id)
    const detail = await this.getSession(session.id)
    events.publish({ type: 'plan.session', session: detail })
    events.publish({ type: 'plan.message', message: toMessage(message) })
    // Leave the response independent of runner/orchestrator work, including
    // synchronous failures. The durable message remains the turn's record.
    setImmediate(() => {
      void this.#queueInitialTurn(session, project, text, attached).catch(error => console.error(`Recording failed PM turn for ${session.id} failed`, error)).finally(() => this.#pendingTurns.delete(session.id))
      void this.#generateTitle(session.id, fallback, { text, attachedTask: attached })
    })
    return detail
  }

  async #retryStart(session: SessionRow, projectId: string): Promise<PlanSessionDetail> {
    if (session.projectId !== projectId) throw new ApiFailure(409, { code: 'conflict', constraint: 'plan_session_project' })
    return this.getSession(session.id)
  }

  async #queueInitialTurn(session: SessionRow, project: ProjectRow, text: string, attached: string | null): Promise<void> {
    try {
      await this.#turn(session, project, {
        prompt: pmPrompt({ text, attachedTask: attached, projectName: project.name, prefix: project.prefix, fresh: true }),
        fallbackPrompt: pmFallbackPrompt({ text, attachedTask: attached, projectName: project.name, prefix: project.prefix, history: await this.#history(session.id) })
      })
    } catch (error) {
      const { db, events } = this.#d
      const message = await insertMessage(db, session.id, { role: 'pm', kind: 'error', text: `Could not queue the PM turn: ${error instanceof Error ? error.message : String(error)}` })
      await db.update(planSessions).set({ updatedAt: new Date(), unread: true }).where(eq(planSessions.id, session.id))
      events.publish({ type: 'plan.message', message: toMessage(message) })
      events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(session.id)) })
    }
  }

  // Replaces the fallback title with one from the runner's smallest model
  // (COR-40). It's a setup job, not a run, so it holds no PM slot. On any
  // failure the fallback stays. A title that's no longer the fallback was
  // changed by someone else and is kept.
  async #generateTitle(sessionId: string, fallback: string, input: { text: string, attachedTask: string | null }): Promise<void> {
    try {
      const result = await this.#d.runner.request({ kind: 'session_title', prompt: sessionTitlePrompt(input) }, TITLE_TIMEOUT_MS)
      const title = cleanSessionTitle(result.title)
      if (!title) throw new Error(`Unusable title "${result.title}"`)
      const [updated] = await this.#d.db.update(planSessions).set({ title })
        .where(and(eq(planSessions.id, sessionId), eq(planSessions.title, fallback))).returning()
      if (updated) this.#d.events.publish({ type: 'plan.session', session: await this.#toSession(updated) })
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
    const updated = await this.#toSession(await this.#session(sessionId))
    this.#d.events.publish({ type: 'plan.session', session: updated })
    return updated
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
      const [pm] = await tx.select({ runtime: agents.runtime }).from(agents).where(eq(agents.role, 'pm')).limit(1)
      const [session] = await tx.insert(planSessions).values({
        projectId: row.project.id, title: `Build: ${row.task.title}`, runtime: pm?.runtime ?? 'claude-code', createdBy: actor
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
  async #staleBuildTasks(prefix: string, designTaskId: string): Promise<{ ref: string, title: string, status: string, version: number }[]> {
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
  async message(sessionId: string, input: { text: string, taskRef?: string | undefined }, actor: Actor): Promise<PlanMessage> {
    const { db } = this.#d
    const session = await this.#session(sessionId)
    const [project] = await db.select().from(projects).where(eq(projects.id, session.projectId))
    if (!project) throw notFound()
    this.assertTurnPossible()
    // One turn at a time per session; other sessions, in this project or
    // another, aren't held back, since the PM has no concurrency (D9, D13)
    const [active] = await db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.role, 'pm'), eq(runs.planSessionId, sessionId), inArray(runs.state, ['queued', 'starting', 'running'])))
    if (active || this.#pendingTurns.has(sessionId)) throw new ApiFailure(409, { code: 'conflict', constraint: 'pm_turn_in_progress' })

    let attached: string | null = null
    if (input.taskRef) {
      const task = await loadTask(db, await this.#taskIdByRef(project, input.taskRef))
      attached = `${task.ref} ${task.title}`
    }
    const text = input.text || `Refine ${attached}`
    const message = await insertMessage(db, sessionId, { role: 'human', kind: 'message', text })
    // A new message reopens a session closed by approving its plan
    await db.update(planSessions).set({ updatedAt: new Date(), unread: false, closedAt: null }).where(eq(planSessions.id, sessionId))
    await appendAudit(db, { projectId: project.id, actor }, auditEvent('plan.message', { sessionId, messageId: message!.id }))
    this.#d.events.publish({ type: 'plan.message', message: toMessage(message!) })

    await this.#turn(session, project, {
      prompt: pmPrompt({ text, attachedTask: attached, projectName: project.name, prefix: project.prefix, fresh: session.agentSessionId === null }),
      fallbackPrompt: pmFallbackPrompt({ text, attachedTask: attached, projectName: project.name, prefix: project.prefix, history: await this.#history(sessionId) })
    })
    return toMessage(message)
  }

  async #turn(session: SessionRow, project: ProjectRow, prompts: { prompt: string, fallbackPrompt: string }): Promise<void> {
    const runId = await this.#d.startRun(session, {
      role: 'pm',
      projectId: project.id,
      repository: project.repository,
      defaultBranch: project.defaultBranch,
      taskId: null,
      taskRef: null,
      branch: null,
      headSha: null,
      planSessionId: session.id,
      agentSessionId: session.agentSessionId,
      runtime: session.runtime,
      model: null,
      timeoutSeconds: PM_TURN_TIMEOUT_SECONDS,
      ...prompts
    })
    this.#d.events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(session.id), runId) })
  }

  // ── Run lifecycle hooks (called by the orchestrator) ───────────────────────

  async onRunStarted(sessionId: string, agentSessionId: string | null): Promise<void> {
    if (agentSessionId) await this.#d.db.update(planSessions).set({ agentSessionId }).where(eq(planSessions.id, sessionId))
  }

  // The PM's reply is what it said last; it's saved from the transcript so
  // the database, not the CLI's session, is the record (D9)
  async onRunEnded(sessionId: string, runId: string, reply: string | null, error: string | null): Promise<void> {
    const { db, events } = this.#d
    if (reply?.trim()) {
      // A run.ended replayed after reconnecting may bring what's already saved
      const [saved] = await db.select({ id: planMessages.id }).from(planMessages)
        .where(and(eq(planMessages.runId, runId), eq(planMessages.kind, 'message'), eq(planMessages.text, reply.trim()))).limit(1)
      if (saved) return
      const message = await insertMessage(db, sessionId, { role: 'pm', kind: 'message', text: reply.trim() }, { runId })
      events.publish({ type: 'plan.message', message: toMessage(message) })
    } else if (error) {
      const message = await insertMessage(db, sessionId, { role: 'pm', kind: 'error', text: error }, { runId })
      events.publish({ type: 'plan.message', message: toMessage(message) })
    }
    // Every finished turn (reply, question or plan) waits for the human to read it
    await db.update(planSessions).set({ updatedAt: new Date(), unread: true }).where(eq(planSessions.id, sessionId))
    events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(sessionId), null) })
  }

  // ── PM tools (flows.md §1) ─────────────────────────────────────────────────

  async tool(sessionId: string, runId: string, tool: string, input: unknown, actor: Actor): Promise<unknown> {
    const { db } = this.#d
    const session = await this.#session(sessionId)
    const [project] = await db.select().from(projects).where(eq(projects.id, session.projectId))
    if (!project) throw new ToolError('The project no longer exists')

    switch (tool) {
      case 'list_tasks': {
        const parsed = listTasksInput.safeParse(input)
        if (!parsed.success) throw new ToolError(`The tasks were not listed: ${z.prettifyError(parsed.error)}`)
        const { status, epic, query, includeMerged } = parsed.data
        const statuses = status === undefined ? [] : [status].flat()
        const rows = await db.select({ id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status, type: tasks.type, priority: tasks.priority, epicId: tasks.epicId }).from(tasks)
          .where(and(
            eq(tasks.projectId, project.id),
            isNull(tasks.deletedAt),
            statuses.length > 0 ? inArray(tasks.status, statuses) : includeMerged ? undefined : ne(tasks.status, 'merged')
          ))
          .orderBy(asc(tasks.number))
        const deps = await db.select({ taskId: taskDependencies.taskId, number: tasks.number }).from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId))
          .where(eq(tasks.projectId, project.id))
        const epicRows = await db.select().from(epics).where(eq(epics.projectId, project.id))
        const epicDeps = await db.select().from(epicDependencies).innerJoin(epics, eq(epics.id, epicDependencies.epicId)).where(eq(epics.projectId, project.id))
        const needle = query?.toLowerCase()
        const matches = rows
          .map(t => ({ ...t, ref: taskRef(project.prefix, t.number) }))
          // In memory: an epic id that isn't a UUID finds nothing here, where Postgres would reject it
          .filter(t => (!epic || t.epicId === epic) && (!needle || t.ref.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle)))
        return {
          project: { name: project.name, prefix: project.prefix, defaultBranch: project.defaultBranch, epicReviewModeDefault: project.epicReviewModeDefault },
          epics: epicRows.map(e => ({ id: e.id, title: e.title, reviewMode: e.reviewMode, dependsOn: epicDeps.filter(d => d.epic_dependencies.epicId === e.id).map(d => d.epic_dependencies.dependsOnEpicId) })),
          tasks: matches.map(t => ({
            ref: t.ref,
            title: t.title,
            status: t.status,
            type: t.type,
            priority: t.priority,
            epicId: t.epicId,
            dependsOn: deps.filter(d => d.taskId === t.id).map(d => taskRef(project.prefix, d.number))
          }))
        }
      }

      case 'get_task': {
        const { taskRef: ref } = z.object({ taskRef: z.string() }).parse(input)
        const task = await loadTask(db, await this.#taskIdByRef(project, ref))
        const notes = await db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id)).orderBy(asc(schema.comments.createdAt))
        const [epic] = task.epicId ? await db.select({ id: epics.id, title: epics.title }).from(epics).where(eq(epics.id, task.epicId)) : []
        return {
          ...task,
          description: richTextToMarkdown(task.description),
          epic: epic ?? null,
          comments: notes.map(c => ({ author: c.author.kind, body: c.body, pinned: c.pinned, at: c.createdAt.toISOString() })),
          attachments: await listTaskAttachments(db, project.id, task.description, notes.map(c => ({ author: c.author.kind, body: c.body, createdAt: c.createdAt })))
        }
      }

      case 'add_comment': {
        const { taskRef: ref, body } = z.object({ taskRef: z.string(), body: z.string().trim().min(1) }).parse(input)
        const comment = await addComment(db, await this.#taskIdByRef(project, ref), { body, pinned: false }, actor)
        this.#d.events.publish({ type: 'comment.created', comment })
        return { ok: true }
      }

      case 'get_run_outcomes': {
        const { taskRef: ref } = z.object({ taskRef: z.string() }).parse(input)
        const taskId = await this.#taskIdByRef(project, ref)
        const rows = await db.select({ run: runs, agent: agents.name }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
          .where(eq(runs.taskId, taskId)).orderBy(desc(runs.number)).limit(20)
        return rows.map(({ run, agent }) => ({
          number: run.number, agent, role: run.role, state: run.state, outcome: run.outcome, summary: run.summary, error: run.error,
          startedAt: run.startedAt?.toISOString() ?? null, endedAt: run.endedAt?.toISOString() ?? null
        }))
      }

      case 'get_agent_activity': {
        const { agent } = z.object({ agent: z.string().trim().min(1).optional() }).parse(input)
        return agentActivity(db, agent).catch((error: unknown) => {
          throw error instanceof UnknownAgent ? new ToolError(error.message) : error
        })
      }

      case 'ask_question': {
        const parsed = askQuestionInput.safeParse(input)
        if (!parsed.success) throw new ToolError(`The question was not asked: ${z.prettifyError(parsed.error)}`)
        const { question, recommendation, options } = parsed.data
        const message = await insertMessage(db, sessionId, { role: 'pm', kind: 'question', text: question, recommendation, options }, { runId })
        this.#d.events.publish({ type: 'plan.message', message: toMessage(message) })
        // The session now has a question: its Inbox item moves up (D11)
        this.#d.events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(sessionId), runId) })
        return { ok: true, message: 'The question is shown to the human. Finish your turn; their answer arrives as the next message.' }
      }

      case 'propose_plan': {
        const parsed = proposedPlanInput.safeParse(input)
        if (!parsed.success) throw new ToolError(`The plan was not saved: ${z.prettifyError(parsed.error)}`)
        return this.#propose(session, project, runId, normalizeProposedPlan(parsed.data), actor)
      }

      // The human's approval, given in chat and carried out by the PM. It's
      // recorded as the human's, via this run, and only counts if they wrote
      // after the plan was proposed: the PM can't approve a plan unseen.
      case 'approve_plan': {
        const { to } = z.object({ to: z.enum(['ready', 'backlog']) }).parse(input)
        const [latest] = await db.select().from(plans).where(eq(plans.sessionId, sessionId)).orderBy(desc(plans.version)).limit(1)
        if (!latest || latest.status !== 'proposed') throw new ToolError('There is no plan waiting for approval in this conversation.')
        const [said] = await db.select({ actor: auditLog.actor, createdAt: auditLog.createdAt }).from(auditLog)
          .where(and(eq(auditLog.action, 'plan.message'), sql`${auditText('plan.message', 'sessionId')} = ${sessionId}`))
          .orderBy(desc(auditLog.createdAt)).limit(1)
        if (!said || said.actor.kind !== 'human' || said.createdAt < latest.createdAt) {
          throw new ToolError('Not approved. The human hasn\'t replied since this plan was proposed; only approve when their latest message asks you to.')
        }
        const approved = await this.approve(latest.id, said.actor, to, { runId }).catch((error: unknown) => {
          if (error instanceof ApiFailure && error.body.code === 'plan_not_approvable') {
            throw new ToolError(`The plan was not approved and nothing was changed: ${error.body.problems.map(p => p.message).join(' ')} Tell the human, and propose a new version without these revisions.`)
          }
          throw error
        })
        return { ok: true, message: `Plan v${approved.version} approved for the human: ${approvedPlanSummary(approved.tasks)}. Tell them it's done.` }
      }

      case 'flag_stale_docs': {
        const { title, description } = z.object({ title: z.string().trim().min(1), description: z.string().trim().min(1) }).parse(input)
        const taskId = await createTask(db, project, {
          title,
          type: 'task',
          description: markdownToRichText(description),
          acceptanceCriteria: ['The documentation matches the code it describes']
        }, actor)
        const task = await loadTask(db, taskId)
        this.#d.events.publish({ type: 'task.created', task })
        return { ok: true, taskRef: task.ref }
      }
    }
    throw new ToolError(`Unknown tool ${tool}`)
  }

  // Validates with core and saves a plan version. Tasks are created as
  // Drafts, seen only in the plan (D10); a revision updates, adds or deletes
  // the ones still in Draft by key. A task with a `ref` revises an existing
  // Backlog or unclaimed Ready task instead: its edits are staged on the plan
  // and written only when the human approves.
  async #propose(session: SessionRow, project: ProjectRow, runId: string, proposed: ProposedPlan, actor: Actor) {
    const { db } = this.#d
    const { found, targets } = await this.#lookupRefs(project, proposed)
    const { found: designs, versionIds } = await this.#lookupDesigns(project, proposed)

    const [latest] = await db.select().from(plans).where(eq(plans.sessionId, session.id)).orderBy(desc(plans.version)).limit(1)
    // A discarded plan's Drafts are gone, so the next version starts afresh
    const previous = latest?.status === 'discarded' ? undefined : latest
    const previousEpics = previous ? await this.#epicsOf(previous) : new Map<string, string>()
    // A lone epic that was renamed is the same epic, so its tasks aren't changed
    const renamed = proposed.epics.length === 1 && previousEpics.size === 1
    const previousTasks = previous ? (await this.#proposedTasksOf(previous, project)).map(t => renamed && t.epic ? { ...t, epic: proposed.epics[0]!.key } : t) : []
    const changes = new Map(diffPlans(previousTasks, proposed.tasks).map(c => [c.key, c.change]))
    const previousEpicRows = previous ? await db.select().from(planEpics).where(eq(planEpics.planId, previous.id)) : []
    for (const epic of proposed.epics) {
      epic.dependsOn ??= previousEpicRows.find(e => e.key === epic.key)?.dependsOn ?? []
    }
    const context = await this.#dependencyContext(project, proposed, previous)
    const problems = checkPlan(proposed, found, designs, context)
    if (problems.length > 0) throw new ToolError(`The plan was not saved: ${JSON.stringify(problems)}. Fix every problem and call propose_plan again.`)

    const plan = await db.transaction(async (tx) => {
      // A tool already past the orchestrator's fence can still be in flight
      // when close stops its run. Serialize its writes with the close.
      const [current] = await tx.select().from(planSessions).where(eq(planSessions.id, session.id)).for('update')
      const [active] = await tx.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.id, runId), inArray(runs.state, ['queued', 'starting', 'running'])))
      if (current!.closedAt || !active) throw new ToolError('This Plan turn has stopped; the plan was not saved.')
      // Each epic the revision still names keeps its row; a lone epic is
      // kept even if its key changed
      const epicIds = new Map<string, string>()
      for (const epic of proposed.epics) {
        const current = renamed ? [...previousEpics.values()][0] : previousEpics.get(epic.key)
        // A revision that leaves the mode out keeps the epic's; a new epic
        // without one takes the project's default (D27)
        if (current) {
          await tx.update(epics).set({ title: epic.title, description: epic.summary, ...(epic.reviewMode && { reviewMode: epic.reviewMode }), updatedAt: new Date() }).where(eq(epics.id, current))
          epicIds.set(epic.key, current)
        } else {
          const reviewMode = epic.reviewMode ?? project.epicReviewModeDefault
          const [row] = await tx.insert(epics).values({ projectId: project.id, title: epic.title, description: epic.summary, reviewMode, createdBy: actor }).returning()
          epicIds.set(epic.key, row!.id)
        }
      }
      if (previous) await tx.update(plans).set({ status: 'superseded' }).where(eq(plans.id, previous.id))
      const [row] = await tx.insert(plans).values({
        sessionId: session.id, projectId: project.id, epicId: proposed.epics[0] ? epicIds.get(proposed.epics[0].key)! : null, version: (latest?.version ?? 0) + 1, title: proposed.title, summary: proposed.summary
      }).returning()
      const planId = row!.id
      if (proposed.epics.length > 0) {
        await tx.insert(planEpics).values(proposed.epics.map((epic, position) => ({ planId, key: epic.key, epicId: epicIds.get(epic.key)!, dependsOn: epic.dependsOn ?? [], position })))
      }
      const epicOf = (task: ProposedTask) => task.epic ? epicIds.get(task.epic)! : null
      const pinOf = (task: ProposedTask) => task.design ? { designVersionId: versionIds.get(designPinKey(task.design))!, screens: task.design.screens } : null

      // The previous version's tasks by key, and of those, the Drafts it
      // created (not the tasks it only revised)
      const previousItems = previous
        ? await tx.select().from(planTasks).where(and(eq(planTasks.planId, previous.id), ne(planTasks.change, 'removed')))
        : []
      const existing = new Map<string, string>()
      for (const r of previousItems) if (r.taskId && !r.revision) existing.set(r.key, r.taskId)
      const owned = new Set(existing.values())
      // Create or update in dependency order isn't needed: dependencies are
      // set in a second pass once every task has a number
      const ids = new Map<string, string>()
      const revising = new Set<string>()
      for (const task of proposed.tasks) {
        const target = task.ref ? targets.get(task.ref)! : null
        // A task an earlier approved version put on the board or in the
        // Backlog is revised like any other
        if (target && (target.status !== 'draft' || !owned.has(target.id))) {
          // Staged below, once every dependency has a number
          ids.set(task.key, target.id)
          revising.add(task.key)
          continue
        }
        // A ref to one of this plan's own Drafts is that Draft
        const current = target?.id ?? existing.get(task.key)
        const input = {
          title: task.title,
          description: markdownToRichText(task.description),
          type: task.type,
          priority: task.priority,
          humanReview: task.humanReview,
          acceptanceCriteria: task.acceptanceCriteria
        }
        if (current) {
          const [row] = await tx.select().from(tasks).where(and(eq(tasks.id, current), isNull(tasks.deletedAt)))
          if (row && row.status === 'draft') {
            await patchTask(tx, project, current, { ...input, acceptanceCriteria: await keepCriterionIds(tx, current, task.acceptanceCriteria) }, actor)
            await setDesignPin(tx, current, pinOf(task))
            ids.set(task.key, current)
            continue
          }
          if (row) {
            // Already on the board or in the Backlog: the plan can't change it
            ids.set(task.key, current)
            continue
          }
        }
        const created = await createTask(tx, project, { ...input, epicId: epicOf(task) }, actor, { draft: true })
        await setDesignPin(tx, created, pinOf(task))
        ids.set(task.key, created)
      }
      const numbers = new Map<string, number>()
      for (const [key, id] of ids) {
        const [row] = await tx.select({ number: tasks.number, status: tasks.status }).from(tasks).where(eq(tasks.id, id))
        numbers.set(key, row!.number)
      }
      // A dependency is a key in the plan, the ref of a task it revises, or
      // any other task in the project
      const keyOfRef = new Map(proposed.tasks.filter(t => t.ref).map(t => [t.ref!, t.key]))
      const numberOf = (dep: string) => numbers.get(dep) ?? numbers.get(keyOfRef.get(dep) ?? '') ?? targets.get(dep)!.number
      const revisions = new Map<string, PlanRevision>()
      for (const task of proposed.tasks) {
        const dependsOn = task.dependsOn.map(numberOf)
        if (revising.has(task.key)) {
          revisions.set(task.key, {
            title: task.title,
            description: task.description,
            type: task.type,
            priority: task.priority,
            humanReview: task.humanReview,
            acceptanceCriteria: task.acceptanceCriteria,
            epicId: epicOf(task),
            dependsOn,
            design: pinOf(task)
          })
          continue
        }
        const [row] = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, ids.get(task.key)!))
        if (row?.status !== 'draft') continue
        await patchTask(tx, project, ids.get(task.key)!, { dependsOn, epicId: epicOf(task) }, actor)
      }
      // Removed Drafts are deleted outright (D10). A revised task the plan
      // drops is only un-staged: it was never changed.
      const kept = new Set(ids.values())
      for (const [, taskId] of existing) {
        if (kept.has(taskId)) continue
        const [row] = await tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
        if (row?.status === 'draft') await deleteTaskRows(tx, taskId, actor, 'Removed from the plan')
      }
      // So are epics the revision dropped, once nothing is left in them
      for (const epicId of previousEpics.values()) {
        if ([...epicIds.values()].includes(epicId)) continue
        const [left] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).limit(1)
        if (!left) await tx.delete(epics).where(eq(epics.id, epicId))
      }
      const dropped = previousItems.filter(r => !ids.has(r.key) && !(r.taskId && kept.has(r.taskId)))
      await insertPlanTasks(tx, [
        ...proposed.tasks.map((task, position): PlanTaskWrite => {
          const change = changes.get(task.key) ?? 'added'
          if (change === 'removed') throw new Error('A proposed task cannot be removed')
          return { planId, key: task.key, taskId: ids.get(task.key)!, change, position, revision: revisions.get(task.key) ?? null }
        }),
        ...dropped.map((r, i) => ({ planId, key: r.key, taskId: r.revision ? r.taskId : null, change: 'removed' as const, position: proposed.tasks.length + i }))
      ])
      await insertMessage(tx, session.id, { role: 'pm', kind: 'message', text: proposed.summary || `Proposed plan v${row!.version}: ${proposed.title}` }, { planId, runId })
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('plan.proposed', { planId, version: row!.version, tasks: proposed.tasks.length, revises: revisions.size }))
      return row!
    })

    const full = await this.toPlan(plan)
    this.#d.events.publish({ type: 'plan.updated', plan: full })
    const planned = new Set(full.epics.map(e => e.id))
    for (const epic of await listEpics(db, project)) {
      if (planned.has(epic.id)) this.#d.events.publish({ type: 'epic.updated', epic })
    }
    const [message] = await db.select().from(planMessages).where(eq(planMessages.planId, plan.id))
    if (message) this.#d.events.publish({ type: 'plan.message', message: toMessage(message) })
    // The session now needs approval: its Inbox item moves up (D11)
    this.#d.events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(session.id), runId) })
    await this.#publishTasks(full)
    await this.#publishDrafts(project.id)
    return { ok: true, planId: plan.id, version: plan.version, tasks: full.tasks.map(t => ({ key: t.key, ref: t.ref, change: t.change, revises: t.revises })), message: 'The plan is saved and shown to the human for approval. Tell them what you proposed and why.' }
  }

  // Approve plan (design/plan.md): human only. Its Drafts go to the board
  // (Ready) or to the Backlog for later or for refining. Tasks it revises
  // get their staged edits first, then go the same way, except that a revised
  // Ready task stays in Ready.
  // `via` is the PM run that carried out the human's say-so in chat
  async approve(planId: string, actor: Actor, to: 'ready' | 'backlog' = 'ready', via: { runId: string } | null = null): Promise<Plan> {
    if (actor.kind !== 'human') throw new ApiFailure(409, { code: 'transition_rejected', reason: { code: 'actor_not_allowed', actor: null, event: 'approve' } })
    const { db } = this.#d
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId))
    if (!plan) throw notFound()
    if (plan.status !== 'proposed') throw new ApiFailure(409, { code: 'conflict', constraint: `plan_${plan.status}` })
    const [project] = await db.select().from(projects).where(eq(projects.id, plan.projectId))
    if (!project) throw notFound()
    const items = await db.select().from(planTasks).where(and(eq(planTasks.planId, planId), ne(planTasks.change, 'removed')))
    const proposed = await this.#planProposal(plan, project)
    const invalidatedEpics: InvalidatedEpics = new Map()
    await db.transaction(async (tx) => {
      await tx.select().from(planSessions).where(eq(planSessions.id, plan.sessionId)).for('update')
      const [current] = await tx.select().from(plans).where(eq(plans.id, planId)).for('update')
      if (current?.status !== 'proposed') throw new ApiFailure(409, { code: 'conflict', constraint: `plan_${current?.status}` })
      // A revised task someone has since claimed, moved on or deleted can't
      // take the plan's edits; nothing is written then. The lock holds off a
      // claim until these edits are in.
      const refused: { code: string, key: string, ref: string, message: string }[] = []
      for (const item of items) {
        if (!item.taskId || !item.revision) continue
        const [row] = await tx.select({ status: tasks.status, leaseRunId: tasks.leaseRunId, deletedAt: tasks.deletedAt }).from(tasks).where(eq(tasks.id, item.taskId)).for('update')
        const ref = proposed.tasks.find(t => t.key === item.key)?.ref ?? item.key
        const found: PlanRef = row && !row.deletedAt ? { kind: 'task', status: row.status, pickedUp: await pickedUp(tx, item.taskId, row.leaseRunId) } : { kind: 'deleted' }
        const problem = revisionProblem(item.key, ref, found)
        if (problem) refused.push({ code: problem.code, key: item.key, ref, message: 'message' in problem ? problem.message : `${ref} can't be revised.` })
      }
      if (refused.length) throw new ApiFailure(409, { code: 'plan_not_approvable', problems: refused })
      const problems = checkPlanEpicDependencies(proposed, await this.#dependencyContext(project, proposed, plan, tx))
      if (problems.length) throw new ApiFailure(409, { code: 'invalid_dependencies', problems })

      for (const item of items) {
        if (!item.taskId) continue
        if (item.revision) await reviseTask(tx, project, item.taskId, item.revision, { planId, version: plan.version }, actor, invalidatedEpics)
        const [row] = await tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.id, item.taskId), isNull(tasks.deletedAt)))
        if (row?.status === 'draft') await transitionTask(tx, item.taskId, { type: to === 'ready' ? 'approve' : 'accept' }, actor, { invalidatedEpics })
        // Revised Backlog tasks, and plans proposed before Drafts existed
        else if (row?.status === 'backlog' && to === 'ready') await transitionTask(tx, item.taskId, { type: 'approve' }, actor, { invalidatedEpics })
      }
      const epicIds = await this.#epicsOf(plan, tx)
      for (const epic of proposed.epics) {
        const epicId = epicIds.get(epic.key)!
        await replaceEpicDependencies(tx, project.id, epicId, (epic.dependsOn ?? []).map(dep => epicIds.get(dep) ?? dep))
      }
      // Approving the plan closes its session
      const now = new Date()
      await recordApproval(tx, planId, { approvedBy: actor, approvedAt: now })
      await tx.update(planSessions).set({ closedAt: now }).where(eq(planSessions.id, plan.sessionId))
    })
    await publishInvalidatedEpics(db, this.#d.events, invalidatedEpics)
    await appendAudit(db, { projectId: plan.projectId, actor }, auditEvent('plan.approved', { planId, version: plan.version, to, ...(via && { viaPmRun: via.runId }) }))
    const full = await this.toPlan((await db.select().from(plans).where(eq(plans.id, planId)))[0]!)
    this.#d.events.publish({ type: 'plan.updated', plan: full })
    await this.#publishTasks(full)
    this.#d.events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(plan.sessionId)) })
    await this.#publishDrafts(plan.projectId)
    return full
  }

  // Discard plan: human only. The Drafts it created are deleted outright
  // (D10); tasks it only revised keep what they have, and a Draft revised
  // from another session goes back to that session.
  async discard(planId: string, actor: Actor): Promise<Plan> {
    if (actor.kind !== 'human') throw new ApiFailure(409, { code: 'conflict', constraint: 'plan_discard_human_only' })
    const { db, events } = this.#d
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId))
    if (!plan) throw notFound()
    if (plan.status !== 'proposed') throw new ApiFailure(409, { code: 'conflict', constraint: `plan_${plan.status}` })
    const items = await db.select().from(planTasks).where(and(eq(planTasks.planId, planId), ne(planTasks.change, 'removed')))
    const deleted: string[] = []
    for (const item of items) {
      if (!item.taskId || item.revision) continue
      const [row] = await db.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.id, item.taskId), isNull(tasks.deletedAt)))
      if (row?.status !== 'draft') continue
      await deleteTaskRows(db, item.taskId, actor, 'Plan discarded')
      deleted.push(item.taskId)
    }
    // So are its epics, once nothing is left in them
    for (const epicId of (await this.#epicsOf(plan)).values()) {
      const [left] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).limit(1)
      if (!left) await db.delete(epics).where(eq(epics.id, epicId))
    }
    await db.update(plans).set({ status: 'discarded' }).where(eq(plans.id, planId))
    await appendAudit(db, { projectId: plan.projectId, actor }, auditEvent('plan.discarded', { planId, version: plan.version, deleted: deleted.length }))
    for (const taskId of deleted) events.publish({ type: 'task.deleted', taskId, projectId: plan.projectId })
    const full = await this.toPlan((await db.select().from(plans).where(eq(plans.id, planId)))[0]!)
    events.publish({ type: 'plan.updated', plan: full })
    await this.#publishTasks(full)
    events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(plan.sessionId)) })
    await this.#publishDrafts(plan.projectId)
    return full
  }

  // The plan's tasks that still exist, e.g. after approval moves them on
  async #publishTasks(plan: Plan): Promise<void> {
    const ids = plan.tasks.flatMap(t => t.taskId ? [t.taskId] : [])
    for (const task of await loadTasks(this.#d.db, ids)) this.#d.events.publish({ type: 'task.updated', task })
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async toPlan(row: PlanRow): Promise<Plan> {
    return (await this.toPlans([row]))[0]!
  }

  // Plans of one project, such as a session's versions
  async toPlans(rows: PlanRow[]): Promise<Plan[]> {
    if (rows.length === 0) return []
    const { db } = this.#d
    const planIds = rows.map(r => r.id)
    const projectId = rows[0]!.projectId
    const [[project], itemRows, snapshotRows, allEpics] = await Promise.all([
      db.select({ prefix: projects.prefix }).from(projects).where(eq(projects.id, projectId)),
      db.select({
        item: planTasks,
        task: { id: tasks.id, number: tasks.number, epicId: tasks.epicId, title: tasks.title, status: tasks.status, priority: tasks.priority, humanReview: tasks.humanReview }
      }).from(planTasks).leftJoin(tasks, eq(tasks.id, planTasks.taskId))
        .where(inArray(planTasks.planId, planIds)).orderBy(asc(planTasks.position)),
      db.select().from(planEpics).where(inArray(planEpics.planId, planIds)).orderBy(asc(planEpics.position)),
      db.select({ id: epics.id, title: epics.title, reviewMode: epics.reviewMode }).from(epics).where(eq(epics.projectId, projectId))
    ])
    const ids = [...new Set(itemRows.flatMap(i => i.task ? [i.task.id] : []))]
    const depRows = ids.length > 0
      ? await db.select({ taskId: taskDependencies.taskId, number: tasks.number }).from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId)).where(inArray(taskDependencies.taskId, ids))
      : []
    const itemsOf = Map.groupBy(itemRows, i => i.item.planId)
    const snapshotsOf = Map.groupBy(snapshotRows, e => e.planId)
    const deps = Map.groupBy(depRows, d => d.taskId)
    const epicOf = new Map(allEpics.map(e => [e.id, e]))
    return rows.map((row) => {
      const snapshots = snapshotsOf.get(row.id) ?? []
      const keyed = epicKeys(row, snapshots)
      const items = itemsOf.get(row.id) ?? []
      const dependenciesOf = (key: string) => (snapshots.find(e => e.key === key)?.dependsOn ?? []).map((dep) => {
        const id = keyed.get(dep) ?? dep
        return { id, title: epicOf.get(id)?.title ?? dep }
      })
      return {
        id: row.id,
        sessionId: row.sessionId,
        projectId: row.projectId,
        epicId: row.epicId,
        version: row.version,
        title: row.title,
        summary: row.summary,
        status: row.status,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        epics: [...keyed].flatMap(([key, id]) => {
          const epic = epicOf.get(id)
          return epic ? [{ key, id, title: epic.title, reviewMode: epic.reviewMode, dependsOn: dependenciesOf(key) }] : []
        }),
        // A revised task shows the plan's staged edits, not what it has now
        tasks: items.map(({ item, task }) => ({
          key: item.key,
          change: item.change,
          revises: Boolean(item.revision),
          taskId: task?.id ?? null,
          epicId: item.revision ? item.revision.epicId : task?.epicId ?? null,
          ref: task && project ? taskRef(project.prefix, task.number) : null,
          title: item.revision?.title ?? task?.title ?? item.key,
          status: task?.status ?? null,
          priority: item.revision?.priority ?? task?.priority ?? 'medium',
          humanReview: item.revision?.humanReview ?? task?.humanReview ?? false,
          dependsOn: item.revision
            ? item.revision.dependsOn.map(n => taskRef(project!.prefix, n))
            : (task ? deps.get(task.id) ?? [] : []).map(d => taskRef(project!.prefix, d.number))
        })),
        createdAt: row.createdAt.toISOString()
      }
    })
  }

  async #proposedTasksOf(plan: PlanRow, project: ProjectRow): Promise<ProposedTask[]> {
    const full = await this.toPlan(plan)
    const keyOf = new Map([...await this.#epicsOf(plan)].map(([key, id]) => [id, key]))
    const keys = new Map(full.tasks.filter(t => t.ref).map(t => [t.ref!, t.key]))
    const revisions = new Map((await this.#d.db.select().from(planTasks).where(eq(planTasks.planId, plan.id))).map(r => [r.key, r.revision]))
    const pinIds = [...revisions.values()].flatMap(r => r?.design ? [r.design.designVersionId] : [])
    const pinned = pinIds.length > 0
      ? await this.#d.db.select({ id: designVersions.id, version: designVersions.version, number: tasks.number }).from(designVersions)
          .innerJoin(tasks, eq(tasks.id, designVersions.taskId)).where(inArray(designVersions.id, pinIds))
      : []
    const pinOf = (pin: { designVersionId: string, screens: string[] } | null | undefined): DesignPin | undefined => {
      const row = pin && pinned.find(p => p.id === pin.designVersionId)
      return row ? { taskRef: taskRef(project.prefix, row.number), version: row.version, screens: pin.screens } : undefined
    }
    const result: ProposedTask[] = []
    for (const item of full.tasks) {
      if (item.change === 'removed' || !item.taskId) continue
      const revision = revisions.get(item.key)
      if (revision) {
        result.push({
          ...revision,
          design: pinOf(revision.design),
          key: item.key,
          ref: item.ref!,
          epic: revision.epicId ? keyOf.get(revision.epicId) ?? revision.epicId : undefined,
          dependsOn: revision.dependsOn.map(n => taskRef(project.prefix, n)).map(ref => keys.get(ref) ?? ref)
        })
        continue
      }
      const task = await loadTask(this.#d.db, item.taskId).catch(() => null)
      if (!task) continue
      result.push({
        key: item.key,
        epic: task.epicId ? keyOf.get(task.epicId) ?? task.epicId : undefined,
        title: task.title,
        description: richTextToMarkdown(task.description),
        type: task.type,
        priority: task.priority,
        humanReview: task.humanReview,
        acceptanceCriteria: task.acceptanceCriteria.map(c => c.checkedByHuman ? { text: c.text, checkedByHuman: true } : c.text),
        dependsOn: task.dependsOn.map(ref => keys.get(ref) ?? ref),
        design: task.design ?? undefined
      })
    }
    return result
  }

  // Looks up every existing-task ref the plan names, for checkPlan, and the
  // tasks the valid ones point at
  async #lookupRefs(project: ProjectRow, plan: ProposedPlan): Promise<{ found: Map<string, PlanRef>, targets: Map<string, RefTarget> }> {
    const { db } = this.#d
    const keys = new Set(plan.tasks.map(t => t.key))
    const names = new Set([
      ...plan.tasks.flatMap(t => t.ref ? [t.ref] : []),
      ...plan.tasks.flatMap(t => t.dependsOn.filter(dep => !keys.has(dep) && REF.test(dep)))
    ])
    const found = new Map<string, PlanRef>()
    const targets = new Map<string, RefTarget>()
    const [current] = await db.select({ nextTaskNumber: projects.nextTaskNumber }).from(projects).where(eq(projects.id, project.id))
    for (const name of names) {
      const match = REF.exec(name)
      if (!match) {
        found.set(name, { kind: 'unknown' })
        continue
      }
      const [, prefix, digits] = match
      const number = Number(digits)
      if (prefix!.toUpperCase() !== project.prefix) {
        const [other] = await db.select({ name: projects.name }).from(projects).where(eq(projects.prefix, prefix!.toUpperCase()))
        found.set(name, other ? { kind: 'other_project', project: other.name } : { kind: 'unknown' })
        continue
      }
      const [row] = await db.select({ id: tasks.id, number: tasks.number, status: tasks.status, leaseRunId: tasks.leaseRunId, deletedAt: tasks.deletedAt }).from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.number, number)))
      if (row && !row.deletedAt) {
        found.set(name, { kind: 'task', status: row.status, pickedUp: await pickedUp(db, row.id, row.leaseRunId) })
        targets.set(name, { id: row.id, number: row.number, status: row.status })
      } else {
        // Backlog tasks are deleted outright, but their number stays used
        found.set(name, row || (number > 0 && number < (current?.nextTaskNumber ?? 0)) ? { kind: 'deleted' } : { kind: 'unknown' })
      }
    }
    return { found, targets }
  }

  // Looks up every design version the plan pins, for checkPlan, and the IDs
  // of the ones that exist. Only this project's design tasks count.
  async #lookupDesigns(project: ProjectRow, plan: ProposedPlan): Promise<{ found: Map<string, DesignPinTarget>, versionIds: Map<string, string> }> {
    const { db } = this.#d
    const found = new Map<string, DesignPinTarget>()
    const versionIds = new Map<string, string>()
    for (const task of plan.tasks) {
      if (!task.design) continue
      const key = designPinKey(task.design)
      if (found.has(key)) continue
      const match = REF.exec(task.design.taskRef)
      const [row] = match && match[1]!.toUpperCase() === project.prefix
        ? await db.select({ id: tasks.id, type: tasks.type, status: tasks.status }).from(tasks)
            .where(and(eq(tasks.projectId, project.id), eq(tasks.number, Number(match[2])), isNull(tasks.deletedAt)))
        : []
      if (!row) {
        found.set(key, { kind: 'unknown' })
        continue
      }
      if (row.type !== 'design') {
        found.set(key, { kind: 'not_design', status: row.status })
        continue
      }
      const [version] = await db.select({ id: designVersions.id, status: designVersions.status }).from(designVersions)
        .where(and(eq(designVersions.taskId, row.id), eq(designVersions.version, task.design.version)))
      found.set(key, version ? { kind: 'version', status: version.status } : { kind: 'unknown' })
      if (version) versionIds.set(key, version.id)
    }
    return { found, versionIds }
  }

  async #planProposal(plan: PlanRow, project: ProjectRow): Promise<ProposedPlan> {
    const full = await this.toPlan(plan)
    const snapshots = await this.#d.db.select().from(planEpics).where(eq(planEpics.planId, plan.id))
    return { title: plan.title, summary: plan.summary, tasks: await this.#proposedTasksOf(plan, project),
      epics: full.epics.map(e => ({ key: e.key, title: e.title, summary: '', dependsOn: snapshots.find(s => s.key === e.key)?.dependsOn ?? [] })) }
  }

  async #dependencyContext(project: ProjectRow, proposed: ProposedPlan, previous?: PlanRow, db: Executor = this.#d.db): Promise<PlanDependencyContext> {
    const epicRows = await db.select().from(epics).where(eq(epics.projectId, project.id))
    const edges = await db.select().from(epicDependencies).innerJoin(epics, eq(epics.id, epicDependencies.epicId)).where(eq(epics.projectId, project.id))
    const rows = await db.select().from(tasks).where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)))
    const deps = await db.select().from(taskDependencies).innerJoin(tasks, eq(tasks.id, taskDependencies.taskId)).where(eq(tasks.projectId, project.id))
    const previousItems = previous ? await db.select().from(planTasks).where(and(eq(planTasks.planId, previous.id), ne(planTasks.change, 'removed'))) : []
    const previousEpics = previous ? await this.#epicsOf(previous, db) : new Map<string, string>()
    const renamed = proposed.epics.length === 1 && previousEpics.size === 1
    const taskIds = new Map(previousItems.flatMap(t => t.taskId ? [[t.key, t.taskId] as const] : []))
    const removedDrafts = new Set(previousItems.filter(t => !proposed.tasks.some(p => p.key === t.key || p.ref === taskRef(project.prefix, rows.find(r => r.id === t.taskId)?.number ?? 0)) && !t.revision).map(t => t.taskId))
    return {
      epics: new Map(epicRows.map(e => [e.id, edges.filter(d => d.epic_dependencies.epicId === e.id).map(d => d.epic_dependencies.dependsOnEpicId)])),
      titles: new Map(epicRows.map(e => [e.id, e.title])),
      epicIds: new Map(proposed.epics.flatMap((e) => {
        const id = renamed ? [...previousEpics.values()][0] : previousEpics.get(e.key)
        return id ? [[e.key, id] as const] : []
      })),
      taskIds,
      refIds: new Map(rows.map(t => [taskRef(project.prefix, t.number), t.id])),
      tasks: rows.filter(t => t.status !== 'draft' || !removedDrafts.has(t.id)).map(t => ({
        id: t.id, type: t.type, epicId: t.epicId, status: t.status,
        dependsOn: deps.filter(d => d.task_dependencies.taskId === t.id).map(d => d.task_dependencies.dependsOnId)
      }))
    }
  }

  // A plan's epics by key, in order. Plans saved before plan_epics have
  // only plans.epicId, under ONLY_EPIC.
  async #epicsOf(plan: PlanRow, db: Executor = this.#d.db): Promise<Map<string, string>> {
    return epicKeys(plan, await db.select().from(planEpics).where(eq(planEpics.planId, plan.id)).orderBy(asc(planEpics.position)))
  }

  async #session(sessionId: string): Promise<SessionRow> {
    const [row] = await this.#d.db.select().from(planSessions).where(eq(planSessions.id, sessionId))
    if (!row) throw notFound()
    return row
  }

  async attachEvidence(sessionId: string, runId: string, text: string): Promise<void> {
    const [message] = await this.#d.db.insert(planMessages).values({ sessionId, role: 'pm', kind: 'message', text, runId }).returning()
    this.#d.events.publish({ type: 'plan.message', message: toMessage(message!) })
    this.#d.events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(sessionId), runId) })
  }

  async #taskIdByRef(project: ProjectRow, ref: string): Promise<string> {
    return (await findTaskByRef(this.#d.db, project, ref)).id
  }

  // The conversation so far, for reseeding a lost session (D9)
  async #history(sessionId: string): Promise<{ role: string, text: string }[]> {
    const rows = await this.#d.db.select().from(planMessages).where(eq(planMessages.sessionId, sessionId)).orderBy(asc(planMessages.createdAt))
    return rows.map(m => ({ role: m.role === 'human' ? 'Human' : m.kind === 'question' ? 'PM (question)' : 'PM', text: m.kind === 'question' ? questionText(m) : m.text }))
  }

  async #toSession(row: SessionRow, activeRunId?: string | null): Promise<PlanSession> {
    return (await sessionState(this.#d.db, row, activeRunId)).session
  }
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

// Each epic key of a plan and the epic it made. Plans saved before plan_epics
// existed have no rows, only plans.epicId.
function epicKeys(plan: Pick<PlanRow, 'epicId'>, rows: (typeof planEpics.$inferSelect)[]): Map<string, string> {
  if (rows.length === 0) return new Map(plan.epicId ? [[ONLY_EPIC, plan.epicId]] : [])
  return new Map(rows.filter(r => r.epicId).map(r => [r.key, r.epicId!]))
}

// A session as the API shows it, with what it waits on, which the Inbox's Plan
// thread items also need (D11)
export async function sessionState(db: Executor, row: SessionRow, activeRunId?: string | null) {
  return (await sessionStates(db, [row], activeRunId))[0]!
}

// One state per row. `activeRunId` is the caller's own knowledge of one
// session's run; otherwise each is read.
export async function sessionStates(db: Executor, rows: SessionRow[], activeRunId?: string | null): Promise<{ session: PlanSession, attention: SessionAttention }[]> {
  if (rows.length === 0) return []
  const ids = rows.map(r => r.id)
  const [lastMessages, proposedPlans, activeRuns] = await Promise.all([
    db.selectDistinctOn([planMessages.sessionId]).from(planMessages).where(inArray(planMessages.sessionId, ids)).orderBy(planMessages.sessionId, desc(planMessages.createdAt)),
    db.select().from(plans).where(and(inArray(plans.sessionId, ids), eq(plans.status, 'proposed'))),
    activeRunId === undefined
      ? db.select({ id: runs.id, sessionId: runs.planSessionId }).from(runs)
          .where(and(eq(runs.role, 'pm'), inArray(runs.planSessionId, ids), inArray(runs.state, ['queued', 'starting', 'running'])))
      : []
  ])
  const lastOf = new Map(lastMessages.map(m => [m.sessionId, m]))
  const proposedOf = new Map(proposedPlans.map(p => [p.sessionId, p]))
  const activeOf = new Map(activeRuns.map(r => [r.sessionId, r.id]))
  return rows.map((row) => {
    const last = lastOf.get(row.id)
    const proposed = proposedOf.get(row.id)
    const attention: SessionAttention = proposed
      ? { status: 'needs_approval', plan: proposed }
      : last?.role === 'pm' && last.kind === 'question'
        ? { status: 'question', question: last }
        : last?.role === 'pm' && last.kind === 'error' ? { status: 'failed', failure: last } : { status: 'none' }
    const session: PlanSession = {
      id: row.id,
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

// Whether an agent holds the task now or has ever run on it
async function pickedUp(db: Executor, taskId: string, leaseRunId: string | null): Promise<boolean> {
  if (leaseRunId) return true
  const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId)).limit(1)
  return Boolean(run)
}

// Writes a plan's staged edits to the task it revises, keeping criterion IDs
// where the text is unchanged
async function reviseTask(tx: Executor, project: ProjectRow, taskId: string, revision: PlanRevision, plan: { planId: string, version: number }, actor: Actor, invalidatedEpics: InvalidatedEpics): Promise<void> {
  await patchTask(tx, project, taskId, {
    title: revision.title,
    description: markdownToRichText(revision.description),
    type: revision.type,
    priority: revision.priority,
    humanReview: revision.humanReview,
    epicId: revision.epicId,
    dependsOn: revision.dependsOn,
    acceptanceCriteria: await keepCriterionIds(tx, taskId, revision.acceptanceCriteria)
  }, actor, invalidatedEpics)
  // Revisions saved before pins existed leave the task's pin alone
  if (revision.design !== undefined) await setDesignPin(tx, taskId, revision.design)
  await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.revised', { ...plan, fields: ['title', 'description', 'type', 'priority', 'humanReview', 'acceptanceCriteria', 'epicId', 'dependsOn', ...(revision.design !== undefined ? ['design'] : [])] }))
}

// A task's new criteria, each with the ID of an existing one that has the
// same text, so evidence and verdicts stay attached to it
async function keepCriterionIds(tx: Executor, taskId: string, texts: (string | { text: string, checkedByHuman?: boolean | undefined })[]): Promise<{ id?: string, text: string, checkedByHuman?: boolean | undefined }[]> {
  const unused = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId)).orderBy(asc(acceptanceCriteria.position))
  return texts.map((criterion) => {
    const { text, checkedByHuman } = typeof criterion === 'string' ? { text: criterion } : criterion
    const index = unused.findIndex(c => c.text === text)
    if (index === -1) return { text, checkedByHuman: checkedByHuman ?? false }
    const matched = unused.splice(index, 1)[0]!
    return { id: matched.id, text, checkedByHuman: checkedByHuman ?? matched.checkedByHuman }
  })
}

// Every message is written here, so its fields match its role and kind
async function insertMessage(db: Executor, sessionId: string, fields: NewPlanMessageFields, links: { planId?: string, runId?: string | null } = {}): Promise<typeof planMessages.$inferSelect> {
  const [row] = await db.insert(planMessages).values({ ...planMessageFields.parse(fields), sessionId, ...links }).returning()
  return row!
}

// Rows older than the constraints aren't checked, so the role and kind are
// read defensively: anything unknown shows as a plain PM message, and only a
// PM question keeps its question fields.
function toMessage(row: typeof planMessages.$inferSelect): PlanMessage {
  const message = {
    id: row.id,
    sessionId: row.sessionId,
    text: row.text,
    planId: row.planId,
    runId: row.runId,
    createdAt: row.createdAt.toISOString()
  }
  if (row.role === 'human') return { ...message, role: 'human', kind: 'message', recommendation: null, options: null }
  if (row.kind === 'question') return { ...message, role: 'pm', kind: 'question', recommendation: row.recommendation, options: row.options }
  return { ...message, role: 'pm', kind: row.kind === 'error' ? 'error' : 'message', recommendation: null, options: null }
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
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New session'
}

// The human's first message in a design's build session (D20)
// A newer version also lists the unstarted build tasks pinned to an older
// one, so the PM can propose revisions that repin them.
function designBuildMessage(ref: string, title: string, version: number, note: string | undefined, stale: { ref: string, title: string, status: string, version: number }[] = []): string {
  const ask = `I approved design v${version} of ${ref} "${title}". Plan its build: read it with get_design (taskRef ${ref}, version ${version}) and propose the build tasks, each pinned to v${version} and the screens it covers.`
  const flagged = stale.length > 0
    ? `These build tasks haven't started and are pinned to an older version, so they're flagged as design changed. Compare their screens with v${version} and propose revisions (include each with its \`ref\`) that repin them to v${version} and update what changed; don't create duplicates of them:\n${stale.map(t => `- ${t.ref} "${t.title}" (${STATUS_NAMES[t.status] ?? t.status}): pinned to v${t.version}, design changed: v${t.version} → v${version}`).join('\n')}`
    : ''
  return [ask, flagged, note ? `Approval note: ${note}` : ''].filter(Boolean).join('\n\n')
}

const STATUS_NAMES: Record<string, string> = { draft: 'Draft', backlog: 'Backlog', ready: 'Ready' }
