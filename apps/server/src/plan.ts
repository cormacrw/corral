import { askQuestionInput, type AgentRuntime, type DraftSession, type Plan, type PlanMessage, type PlanSession, type PlanSessionDetail, type RunJob } from '@corral/contracts'
import { checkPlan, designPinKey, diffPlans, isDesignPinStale, markdownToRichText, REVISABLE_STATUSES, requiresHumanReview, richTextToMarkdown, TASK_TYPES, taskRef, type Actor, type DesignPin, type DesignPinTarget, type PlanRef, type ProposedPlan, type ProposedTask } from '@corral/core'
import { schema, type Database, type Executor, type PlanRevision } from '@corral/db'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { listTaskAttachments } from './attachments.ts'
import { listEpics } from './epics.ts'
import { ApiFailure, notFound } from './errors.ts'
import type { EventBus } from './events.ts'
import { pmFallbackPrompt, pmPrompt, questionText, sessionTitlePrompt } from './prompts.ts'
import type { RunnerHub } from './runner-hub.ts'
import { createTask, deleteTaskRows, draftSessions, findTaskId, loadTask, patchTask, pinStaleness, setDesignPin, transitionTask, type ProjectRow } from './tasks.ts'

const { acceptanceCriteria, agents, auditLog, designVersions, epics, planEpics, planMessages, planSessions, planTasks, plans, projects, runs, taskDependencies, taskDesignPins, tasks } = schema

const PM_TURN_TIMEOUT_SECONDS = 20 * 60
// The runner gives `claude` 30 s to write a title; this covers the round trip
const TITLE_TIMEOUT_MS = 40_000
const TITLE_MAX_WORDS = 6
const TITLE_MAX_LENGTH = 60

// Thrown back to the PM as a tool error
class ToolError extends Error {}

const proposedTask = z.object({
  key: z.string().trim().min(1),
  ref: z.string().trim().toUpperCase().optional().transform(ref => ref || undefined),
  epic: z.string().trim().optional(),
  title: z.string().trim().min(1),
  description: z.string().trim(),
  type: z.enum(TASK_TYPES),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
  humanReview: z.boolean().default(false),
  acceptanceCriteria: z.array(z.string().trim()).default([]),
  dependsOn: z.array(z.string().trim()).default([]),
  // The approved design version a build task builds (D20)
  design: z.object({
    taskRef: z.string().trim().toUpperCase(),
    version: z.number().int().positive(),
    screens: z.array(z.string().trim()).default([])
  }).optional()
})

// The key old plans that stored only plans.epicId give their epic. New
// plans without `epics` have no epic.
const ONLY_EPIC = 'main'

const proposedPlan = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().default(''),
  epics: z.array(z.object({
    key: z.string().trim().min(1),
    title: z.string().trim(),
    summary: z.string().trim().default('')
  })).default([]),
  tasks: z.array(proposedTask)
}).transform((plan): ProposedPlan => {
  // A dependency that isn't a key is an existing task's ref, in any case
  const keys = new Set(plan.tasks.map(t => t.key))
  const dependency = (dep: string) => keys.has(dep) || !REF.test(dep) ? dep : dep.toUpperCase()
  // A task without `epic` has no epic. A design task always gets human
  // review, whatever the PM asked for (D20).
  return { ...plan, tasks: plan.tasks.map(t => ({ ...t, epic: t.epic || undefined, humanReview: requiresHumanReview(t.type, t.humanReview), dependsOn: t.dependsOn.map(dependency) })) }
})

const REF = /^([A-Za-z]+)-(\d+)$/

// An existing task a plan names by ref
interface RefTarget {
  id: string
  number: number
  status: string
}

type SessionRow = typeof planSessions.$inferSelect
type PlanRow = typeof plans.$inferSelect

export interface PlanDeps {
  db: Database
  events: EventBus
  runner: RunnerHub
  // True while the update hold is on; no turn may start
  updating(): boolean
  // Starts a PM run for a session; the orchestrator owns runs. The job
  // carries the session's runtime, not the PM agent's (D18).
  startRun(session: SessionRow, job: Omit<RunJob, 'runId' | 'runNumber' | 'leaseEpoch'>): Promise<string>
}

// The PM conversation (D9, design/plan.md). Each turn is a runner job with
// role `pm`; the PM's tools here are the only way it touches the board, and
// none of them approve, merge or change status.
export class PlanService {
  #d: PlanDeps

  constructor(deps: PlanDeps) {
    this.#d = deps
  }

  async listSessions(): Promise<PlanSession[]> {
    const rows = await this.#d.db.select().from(planSessions).orderBy(desc(planSessions.updatedAt))
    return Promise.all(rows.map(row => this.#toSession(row)))
  }

  async getSession(sessionId: string): Promise<PlanSessionDetail> {
    const row = await this.#session(sessionId)
    const messages = await this.#d.db.select().from(planMessages).where(eq(planMessages.sessionId, sessionId)).orderBy(asc(planMessages.createdAt))
    const planRows = await this.#d.db.select().from(plans).where(eq(plans.sessionId, sessionId)).orderBy(asc(plans.version))
    return {
      ...(await this.#toSession(row)),
      messages: messages.map(toMessage),
      plans: await Promise.all(planRows.map(p => this.toPlan(p)))
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
    this.#d.events.publish({ type: 'plan.session', session })
    return session
  }

  // design/plan.md: the project and runtime are locked once the session has messages
  async start(projectId: string, input: { text: string, taskRef?: string | undefined, runtime?: AgentRuntime }, actor: Actor): Promise<PlanSessionDetail> {
    const [project] = await this.#d.db.select().from(projects).where(eq(projects.id, projectId))
    if (!project) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['projectId'], message: 'Unknown project' }] })
    const text = input.text || (input.taskRef ? `Refine ${input.taskRef}` : '')
    const fallback = titleFrom(text)
    const [session] = await this.#d.db.insert(planSessions).values({ projectId, title: fallback, runtime: input.runtime ?? 'claude-code', createdBy: actor }).returning()
    await this.message(session!.id, input, actor)
    const attached = input.taskRef ? await loadTask(this.#d.db, await this.#taskIdByRef(project, input.taskRef)) : null
    // Not awaited: the PM turn is already queued and doesn't wait for it
    void this.#generateTitle(session!.id, fallback, { text, attachedTask: attached && `${attached.ref} ${attached.title}` })
    return this.getSession(session!.id)
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
      await db.insert(auditLog).values({ projectId: session.projectId, actor, action: 'plan.runtime', detail: { sessionId, from: session.runtime, to: runtime } })
    }
    const updated = await this.#toSession(await this.#session(sessionId))
    this.#d.events.publish({ type: 'plan.session', session: updated })
    return updated
  }

  // A turn needs the runner, and none starts during the update hold (D9)
  assertTurnPossible(): void {
    if (!this.#d.runner.online) throw new ApiFailure(503, { code: 'runner_offline' })
    if (this.#d.updating()) throw new ApiFailure(503, { code: 'corral_updating' })
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
    if (active) throw new ApiFailure(409, { code: 'conflict', constraint: 'pm_turn_in_progress' })

    let attached: string | null = null
    if (input.taskRef) {
      const task = await loadTask(db, await this.#taskIdByRef(project, input.taskRef))
      attached = `${task.ref} ${task.title}`
    }
    const text = input.text || `Refine ${attached}`
    const [message] = await db.insert(planMessages).values({ sessionId, role: 'human', text, runId: null }).returning()
    // A new message reopens a session closed by approving its plan
    await db.update(planSessions).set({ updatedAt: new Date(), unread: false, closedAt: null }).where(eq(planSessions.id, sessionId))
    await db.insert(auditLog).values({ projectId: project.id, actor, action: 'plan.message', detail: { sessionId, messageId: message!.id } })
    this.#d.events.publish({ type: 'plan.message', message: toMessage(message!) })

    await this.#turn(session, project, {
      prompt: pmPrompt({ text, attachedTask: attached, projectName: project.name, prefix: project.prefix, fresh: session.agentSessionId === null }),
      fallbackPrompt: pmFallbackPrompt({ text, attachedTask: attached, projectName: project.name, prefix: project.prefix, history: await this.#history(sessionId) })
    })
    return toMessage(message!)
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
      const [message] = await db.insert(planMessages).values({ sessionId, role: 'pm', kind: 'message', text: reply.trim(), runId }).returning()
      events.publish({ type: 'plan.message', message: toMessage(message!) })
    } else if (error) {
      const [message] = await db.insert(planMessages).values({ sessionId, role: 'pm', kind: 'error', text: error, runId }).returning()
      events.publish({ type: 'plan.message', message: toMessage(message!) })
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
        const rows = await db.select().from(tasks).where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
        const deps = await db.select({ taskId: taskDependencies.taskId, number: tasks.number }).from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId))
        const epicRows = await db.select().from(epics).where(eq(epics.projectId, project.id))
        return {
          project: { name: project.name, prefix: project.prefix, defaultBranch: project.defaultBranch },
          epics: epicRows.map(e => ({ id: e.id, title: e.title })),
          tasks: rows.map(t => ({
            ref: taskRef(project.prefix, t.number),
            title: t.title,
            status: t.status,
            priority: t.priority,
            type: t.type,
            epicId: t.epicId,
            humanReview: t.humanReview,
            statusReason: t.statusReason,
            pr: t.prUrl,
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

      case 'ask_question': {
        const parsed = askQuestionInput.safeParse(input)
        if (!parsed.success) throw new ToolError(`The question was not asked: ${z.prettifyError(parsed.error)}`)
        const { question, recommendation, options } = parsed.data
        const [message] = await db.insert(planMessages).values({ sessionId, role: 'pm', kind: 'question', text: question, recommendation, options, runId }).returning()
        this.#d.events.publish({ type: 'plan.message', message: toMessage(message!) })
        // The session now has a question: its Inbox item moves up (D11)
        this.#d.events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(sessionId), runId) })
        return { ok: true, message: 'The question is shown to the human. Finish your turn; their answer arrives as the next message.' }
      }

      case 'propose_plan':
        return this.#propose(session, project, runId, proposedPlan.parse(input), actor)

      // The human's approval, given in chat and carried out by the PM. It's
      // recorded as the human's, via this run, and only counts if they wrote
      // after the plan was proposed: the PM can't approve a plan unseen.
      case 'approve_plan': {
        const { to } = z.object({ to: z.enum(['ready', 'backlog']) }).parse(input)
        const [latest] = await db.select().from(plans).where(eq(plans.sessionId, sessionId)).orderBy(desc(plans.version)).limit(1)
        if (!latest || latest.status !== 'proposed') throw new ToolError('There is no plan waiting for approval in this conversation.')
        const [said] = await db.select({ actor: auditLog.actor, createdAt: auditLog.createdAt }).from(auditLog)
          .where(and(eq(auditLog.action, 'plan.message'), sql`${auditLog.detail}->>'sessionId' = ${sessionId}`))
          .orderBy(desc(auditLog.createdAt)).limit(1)
        if (!said || said.actor.kind !== 'human' || said.createdAt < latest.createdAt) {
          throw new ToolError('Not approved. The human hasn\'t replied since this plan was proposed; only approve when their latest message asks you to.')
        }
        const approved = await this.approve(latest.id, said.actor, to, { runId })
        const count = approved.tasks.filter(t => t.change !== 'removed').length
        return { ok: true, message: `Plan v${approved.version} approved for the human: ${count} task${count === 1 ? '' : 's'} added to the ${to === 'ready' ? 'board' : 'Backlog'}. Tell them it's done.` }
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
  // Backlog task instead: its edits are staged on the plan and written only
  // when the human approves.
  async #propose(session: SessionRow, project: ProjectRow, runId: string, proposed: ProposedPlan, actor: Actor) {
    const { db } = this.#d
    const { found, targets } = await this.#lookupRefs(project, proposed)
    const { found: designs, versionIds } = await this.#lookupDesigns(project, proposed)
    const problems = checkPlan(proposed, found, designs)
    if (problems.length > 0) throw new ToolError(`The plan was not saved: ${JSON.stringify(problems)}. Fix every problem and call propose_plan again.`)

    const [latest] = await db.select().from(plans).where(eq(plans.sessionId, session.id)).orderBy(desc(plans.version)).limit(1)
    // A discarded plan's Drafts are gone, so the next version starts afresh
    const previous = latest?.status === 'discarded' ? undefined : latest
    const previousEpics = previous ? await this.#epicsOf(previous) : new Map<string, string>()
    // A lone epic that was renamed is the same epic, so its tasks aren't changed
    const renamed = proposed.epics.length === 1 && previousEpics.size === 1
    const previousTasks = previous ? (await this.#proposedTasksOf(previous, project)).map(t => renamed && t.epic ? { ...t, epic: proposed.epics[0]!.key } : t) : []
    const changes = new Map(diffPlans(previousTasks, proposed.tasks).map(c => [c.key, c.change]))

    const plan = await db.transaction(async (tx) => {
      // Each epic the revision still names keeps its row; a lone epic is
      // kept even if its key changed
      const epicIds = new Map<string, string>()
      for (const epic of proposed.epics) {
        const current = renamed ? [...previousEpics.values()][0] : previousEpics.get(epic.key)
        if (current) {
          await tx.update(epics).set({ title: epic.title, description: epic.summary, updatedAt: new Date() }).where(eq(epics.id, current))
          epicIds.set(epic.key, current)
        } else {
          const [row] = await tx.insert(epics).values({ projectId: project.id, title: epic.title, description: epic.summary, createdBy: actor }).returning()
          epicIds.set(epic.key, row!.id)
        }
      }
      if (previous) await tx.update(plans).set({ status: 'superseded' }).where(eq(plans.id, previous.id))
      const [row] = await tx.insert(plans).values({
        sessionId: session.id, projectId: project.id, epicId: proposed.epics[0] ? epicIds.get(proposed.epics[0].key)! : null, version: (latest?.version ?? 0) + 1, title: proposed.title, summary: proposed.summary
      }).returning()
      const planId = row!.id
      if (proposed.epics.length > 0) {
        await tx.insert(planEpics).values(proposed.epics.map((epic, position) => ({ planId, key: epic.key, epicId: epicIds.get(epic.key)!, position })))
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
        if (target && !owned.has(target.id)) {
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
      await tx.insert(planTasks).values([
        ...proposed.tasks.map((task, position) => ({ planId, key: task.key, taskId: ids.get(task.key)!, change: changes.get(task.key) ?? 'added', position, revision: revisions.get(task.key) ?? null })),
        ...dropped.map((r, i) => ({ planId, key: r.key, taskId: r.revision ? r.taskId : null, change: 'removed' as const, position: proposed.tasks.length + i }))
      ])
      await tx.insert(planMessages).values({ sessionId: session.id, role: 'pm', kind: 'message', text: proposed.summary || `Proposed plan v${row!.version}: ${proposed.title}`, planId, runId })
      await tx.insert(auditLog).values({ projectId: project.id, actor, action: 'plan.proposed', detail: { planId, version: row!.version, tasks: proposed.tasks.length, revises: revisions.size } })
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
  // get their staged edits first, then go the same way.
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
    await db.transaction(async (tx) => {
      // A revised task someone has since started (or deleted) can't take the
      // plan's edits; nothing is written then
      for (const item of items) {
        if (!item.taskId || !item.revision) continue
        const [row] = await tx.select({ number: tasks.number, status: tasks.status }).from(tasks).where(and(eq(tasks.id, item.taskId), isNull(tasks.deletedAt)))
        if (!row || !REVISABLE_STATUSES.includes(row.status)) throw new ApiFailure(409, { code: 'conflict', constraint: 'revised_task_not_in_backlog' })
      }
      for (const item of items) {
        if (!item.taskId) continue
        if (item.revision) await reviseTask(tx, project, item.taskId, item.revision, { planId, version: plan.version }, actor)
        const [row] = await tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.id, item.taskId), isNull(tasks.deletedAt)))
        if (row?.status === 'draft') await transitionTask(tx, item.taskId, { type: to === 'ready' ? 'approve' : 'accept' }, actor)
        // Revised Backlog tasks, and plans proposed before Drafts existed
        else if (row?.status === 'backlog' && to === 'ready') await transitionTask(tx, item.taskId, { type: 'approve' }, actor)
      }
      // Approving the plan closes its session
      const now = new Date()
      await tx.update(plans).set({ status: 'approved', approvedBy: actor, approvedAt: now }).where(eq(plans.id, planId))
      await tx.update(planSessions).set({ closedAt: now }).where(eq(planSessions.id, plan.sessionId))
    })
    await db.insert(auditLog).values({ projectId: plan.projectId, actor, action: 'plan.approved', detail: { planId, version: plan.version, to, ...(via && { viaPmRun: via.runId }) } })
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
    await db.insert(auditLog).values({ projectId: plan.projectId, actor, action: 'plan.discarded', detail: { planId, version: plan.version, deleted: deleted.length } })
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
    for (const t of plan.tasks) {
      if (!t.taskId) continue
      const task = await loadTask(this.#d.db, t.taskId).catch(() => null)
      if (task) this.#d.events.publish({ type: 'task.updated', task })
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async toPlan(row: PlanRow): Promise<Plan> {
    const { db } = this.#d
    const [project] = await db.select().from(projects).where(eq(projects.id, row.projectId))
    const items = await db.select({ item: planTasks, task: tasks }).from(planTasks).leftJoin(tasks, eq(tasks.id, planTasks.taskId))
      .where(eq(planTasks.planId, row.id)).orderBy(asc(planTasks.position))
    const ids = items.map(i => i.task?.id).filter((id): id is string => Boolean(id))
    const deps = ids.length > 0
      ? await db.select({ taskId: taskDependencies.taskId, number: tasks.number }).from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId)).where(inArray(taskDependencies.taskId, ids))
      : []
    const keyed = await this.#epicsOf(row)
    const epicRows = keyed.size > 0 ? await db.select({ id: epics.id, title: epics.title }).from(epics).where(inArray(epics.id, [...keyed.values()])) : []
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
      epics: [...keyed].flatMap(([key, id]) => epicRows.filter(e => e.id === id).map(e => ({ key, id, title: e.title }))),
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
          : deps.filter(d => d.taskId === task?.id).map(d => taskRef(project!.prefix, d.number))
      })),
      createdAt: row.createdAt.toISOString()
    }
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
          epic: revision.epicId ? keyOf.get(revision.epicId) : undefined,
          dependsOn: revision.dependsOn.map(n => taskRef(project.prefix, n)).map(ref => keys.get(ref) ?? ref)
        })
        continue
      }
      const task = await loadTask(this.#d.db, item.taskId).catch(() => null)
      if (!task) continue
      result.push({
        key: item.key,
        epic: task.epicId ? keyOf.get(task.epicId) : undefined,
        title: task.title,
        description: richTextToMarkdown(task.description),
        type: task.type,
        priority: task.priority,
        humanReview: task.humanReview,
        acceptanceCriteria: task.acceptanceCriteria.map(c => c.text),
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
      const [row] = await db.select({ id: tasks.id, number: tasks.number, status: tasks.status, deletedAt: tasks.deletedAt }).from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.number, number)))
      if (row && !row.deletedAt) {
        found.set(name, { kind: 'task', status: row.status })
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

  // A plan's epics by key, in order. Plans saved before plan_epics have
  // only plans.epicId, under ONLY_EPIC.
  async #epicsOf(plan: PlanRow): Promise<Map<string, string>> {
    const rows = await this.#d.db.select().from(planEpics).where(eq(planEpics.planId, plan.id)).orderBy(asc(planEpics.position))
    if (rows.length === 0) return new Map(plan.epicId ? [[ONLY_EPIC, plan.epicId]] : [])
    return new Map(rows.filter(r => r.epicId).map(r => [r.key, r.epicId!]))
  }

  async #session(sessionId: string): Promise<SessionRow> {
    const [row] = await this.#d.db.select().from(planSessions).where(eq(planSessions.id, sessionId))
    if (!row) throw notFound()
    return row
  }

  async #taskIdByRef(project: ProjectRow, ref: string): Promise<string> {
    const match = new RegExp(`^${project.prefix}-(\\d+)$`, 'i').exec(ref.trim())
    if (!match) throw new ToolError(`No task ${ref} in this project (refs look like ${project.prefix}-12)`)
    return findTaskId(this.#d.db, project.id, Number(match[1])).catch(() => {
      throw new ToolError(`No task ${ref} in this project`)
    })
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

// A session as the API shows it, with the plan waiting for approval and its
// latest message, which the Inbox's Plan thread items also need (D11)
export async function sessionState(db: Executor, row: SessionRow, activeRunId?: string | null): Promise<{ session: PlanSession, planId: string | null, last: typeof planMessages.$inferSelect | null }> {
  const [last] = await db.select().from(planMessages).where(eq(planMessages.sessionId, row.id)).orderBy(desc(planMessages.createdAt)).limit(1)
  const [proposed] = await db.select({ id: plans.id }).from(plans).where(and(eq(plans.sessionId, row.id), eq(plans.status, 'proposed'))).limit(1)
  let runId = activeRunId ?? null
  if (activeRunId === undefined) {
    const [active] = await db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.role, 'pm'), eq(runs.planSessionId, row.id), inArray(runs.state, ['queued', 'starting', 'running'])))
    runId = active?.id ?? null
  }
  const session: PlanSession = {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    runtime: row.runtime as AgentRuntime,
    preview: last?.text.slice(0, 160) ?? '',
    unread: row.unread,
    closed: row.closedAt !== null,
    status: proposed ? 'needs_approval' : last?.kind === 'question' ? 'question' : 'none',
    activeRunId: runId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
  return { session, planId: proposed?.id ?? null, last: last ?? null }
}

// Writes a plan's staged edits to the task it revises, keeping criterion IDs
// where the text is unchanged
async function reviseTask(tx: Executor, project: ProjectRow, taskId: string, revision: PlanRevision, plan: { planId: string, version: number }, actor: Actor): Promise<void> {
  await patchTask(tx, project, taskId, {
    title: revision.title,
    description: markdownToRichText(revision.description),
    type: revision.type,
    priority: revision.priority,
    humanReview: revision.humanReview,
    epicId: revision.epicId,
    dependsOn: revision.dependsOn,
    acceptanceCriteria: await keepCriterionIds(tx, taskId, revision.acceptanceCriteria)
  }, actor)
  // Revisions saved before pins existed leave the task's pin alone
  if (revision.design !== undefined) await setDesignPin(tx, taskId, revision.design)
  await tx.insert(auditLog).values({ projectId: project.id, taskId, actor, action: 'task.revised', detail: { ...plan, fields: ['title', 'description', 'type', 'priority', 'humanReview', 'acceptanceCriteria', 'epicId', 'dependsOn', ...(revision.design !== undefined ? ['design'] : [])] } })
}

// A task's new criteria, each with the ID of an existing one that has the
// same text, so evidence and verdicts stay attached to it
async function keepCriterionIds(tx: Executor, taskId: string, texts: string[]): Promise<{ id?: string, text: string }[]> {
  const unused = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId)).orderBy(asc(acceptanceCriteria.position))
  return texts.map((text) => {
    const index = unused.findIndex(c => c.text === text)
    if (index === -1) return { text }
    return { id: unused.splice(index, 1)[0]!.id, text }
  })
}

function toMessage(row: typeof planMessages.$inferSelect): PlanMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as 'human' | 'pm',
    kind: row.kind as PlanMessage['kind'],
    text: row.text,
    recommendation: row.recommendation,
    options: row.options,
    planId: row.planId,
    runId: row.runId,
    createdAt: row.createdAt.toISOString()
  }
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
