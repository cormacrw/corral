import type { Plan, PlanMessage, PlanSession, PlanSessionDetail, RunJob } from '@corral/contracts'
import { checkPlan, diffPlans, markdownToRichText, richTextToMarkdown, taskRef, type Actor, type ProposedPlan, type ProposedTask } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { listEpics } from './epics.ts'
import { ApiFailure, notFound } from './errors.ts'
import type { EventBus } from './events.ts'
import { pmFallbackPrompt, pmPrompt } from './prompts.ts'
import type { RunnerHub } from './runner-hub.ts'
import { createTask, deleteTaskRows, findTaskId, loadTask, patchTask, transitionTask, type ProjectRow } from './tasks.ts'

const { acceptanceCriteria, agents, auditLog, epics, planMessages, planSessions, planTasks, plans, projects, runs, taskDependencies, tasks } = schema

const PM_TURN_TIMEOUT_SECONDS = 20 * 60

// Thrown back to the PM as a tool error
class ToolError extends Error {}

const proposedTask = z.object({
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim(),
  type: z.enum(['frontend', 'backend', 'full_stack', 'infrastructure']),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
  humanReview: z.boolean().default(false),
  acceptanceCriteria: z.array(z.string().trim()).default([]),
  dependsOn: z.array(z.string().trim()).default([])
})

const proposedPlan = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().default(''),
  tasks: z.array(proposedTask)
})

type SessionRow = typeof planSessions.$inferSelect
type PlanRow = typeof plans.$inferSelect

export interface PlanDeps {
  db: Database
  events: EventBus
  runner: RunnerHub
  // Starts a PM run for a session; the orchestrator owns runs
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

  async markRead(sessionId: string): Promise<PlanSession> {
    await this.#d.db.update(planSessions).set({ unread: false }).where(eq(planSessions.id, sessionId))
    const session = await this.#toSession(await this.#session(sessionId))
    this.#d.events.publish({ type: 'plan.session', session })
    return session
  }

  // design/plan.md: the project is locked once the session has messages
  async start(projectId: string, input: { text: string, taskRef?: string | undefined }, actor: Actor): Promise<PlanSessionDetail> {
    const [project] = await this.#d.db.select().from(projects).where(eq(projects.id, projectId))
    if (!project) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['projectId'], message: 'Unknown project' }] })
    const text = input.text || (input.taskRef ? `Refine ${input.taskRef}` : '')
    const [session] = await this.#d.db.insert(planSessions).values({ projectId, title: titleFrom(text), createdBy: actor }).returning()
    await this.message(session!.id, input, actor)
    return this.getSession(session!.id)
  }

  // A human message starts one PM turn (D9)
  async message(sessionId: string, input: { text: string, taskRef?: string | undefined }, actor: Actor): Promise<PlanMessage> {
    const { db } = this.#d
    const session = await this.#session(sessionId)
    const [project] = await db.select().from(projects).where(eq(projects.id, session.projectId))
    if (!project) throw notFound()
    if (!this.#d.runner.online) throw new ApiFailure(503, { code: 'runner_offline' })
    const [active] = await db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.role, 'pm'), eq(runs.projectId, session.projectId), inArray(runs.state, ['queued', 'starting', 'running'])))
    if (active) throw new ApiFailure(409, { code: 'conflict', constraint: 'pm_turn_in_progress' })

    let attached: string | null = null
    if (input.taskRef) {
      const task = await loadTask(db, await this.#taskIdByRef(project, input.taskRef))
      attached = `${task.ref} ${task.title}`
    }
    const text = input.text || `Refine ${attached}`
    const [message] = await db.insert(planMessages).values({ sessionId, role: 'human', text, runId: null }).returning()
    await db.update(planSessions).set({ updatedAt: new Date(), unread: false }).where(eq(planSessions.id, sessionId))
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
      agentSessionId: session.agentSessionId,
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
    await db.update(planSessions).set({ updatedAt: new Date() }).where(eq(planSessions.id, sessionId))
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
        return {
          ...task,
          description: richTextToMarkdown(task.description),
          comments: notes.map(c => ({ author: c.author.kind, body: c.body, pinned: c.pinned, at: c.createdAt.toISOString() }))
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
        const { question } = z.object({ question: z.string().trim().min(1) }).parse(input)
        const [message] = await db.insert(planMessages).values({ sessionId, role: 'pm', kind: 'question', text: question, runId }).returning()
        this.#d.events.publish({ type: 'plan.message', message: toMessage(message!) })
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
          type: 'infrastructure',
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
  // the ones still in Draft by key.
  async #propose(session: SessionRow, project: ProjectRow, runId: string, proposed: ProposedPlan, actor: Actor) {
    const { db } = this.#d
    const problems = checkPlan(proposed)
    if (problems.length > 0) throw new ToolError(`The plan was not saved: ${JSON.stringify(problems)}. Fix every problem and call propose_plan again.`)

    const [previous] = await db.select().from(plans).where(eq(plans.sessionId, session.id)).orderBy(desc(plans.version)).limit(1)
    const previousTasks = previous ? await this.#proposedTasksOf(previous, project) : []
    const changes = new Map(diffPlans(previousTasks, proposed.tasks).map(c => [c.key, c.change]))

    const plan = await db.transaction(async (tx) => {
      let epicId = previous?.epicId ?? null
      if (!epicId) {
        const [epic] = await tx.insert(epics).values({ projectId: project.id, title: proposed.title, description: proposed.summary, createdBy: actor }).returning()
        epicId = epic!.id
      } else {
        await tx.update(epics).set({ title: proposed.title, description: proposed.summary, updatedAt: new Date() }).where(eq(epics.id, epicId))
      }
      if (previous) await tx.update(plans).set({ status: 'superseded' }).where(eq(plans.id, previous.id))
      const [row] = await tx.insert(plans).values({
        sessionId: session.id, projectId: project.id, epicId, version: (previous?.version ?? 0) + 1, title: proposed.title, summary: proposed.summary
      }).returning()
      const planId = row!.id

      // Existing tasks by key, from the previous version
      const existing = new Map<string, string>()
      if (previous) {
        const rows = await tx.select().from(planTasks).where(and(eq(planTasks.planId, previous.id), ne(planTasks.change, 'removed')))
        for (const r of rows) if (r.taskId) existing.set(r.key, r.taskId)
      }
      // Create or update in dependency order isn't needed: dependencies are
      // set in a second pass once every task has a number
      const ids = new Map<string, string>()
      for (const task of proposed.tasks) {
        const current = existing.get(task.key)
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
            const criteria = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, current)).orderBy(asc(acceptanceCriteria.position))
            await patchTask(tx, project, current, {
              ...input,
              // Keep IDs where the text is unchanged
              acceptanceCriteria: task.acceptanceCriteria.map(text => ({ text, ...(criteria.find(c => c.text === text) && { id: criteria.find(c => c.text === text)!.id }) }))
            }, actor)
            ids.set(task.key, current)
            continue
          }
          if (row) {
            // Already on the board or in the Backlog: the plan can't change it
            ids.set(task.key, current)
            continue
          }
        }
        ids.set(task.key, await createTask(tx, project, { ...input, epicId }, actor, { draft: true }))
      }
      const numbers = new Map<string, number>()
      for (const [key, id] of ids) {
        const [row] = await tx.select({ number: tasks.number, status: tasks.status }).from(tasks).where(eq(tasks.id, id))
        numbers.set(key, row!.number)
      }
      for (const task of proposed.tasks) {
        const [row] = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, ids.get(task.key)!))
        if (row?.status !== 'draft') continue
        await patchTask(tx, project, ids.get(task.key)!, { dependsOn: task.dependsOn.map(k => numbers.get(k)!), epicId }, actor)
      }
      // Removed Drafts are deleted outright (D10)
      for (const [key, taskId] of existing) {
        if (ids.has(key)) continue
        const [row] = await tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
        if (row?.status === 'draft') await deleteTaskRows(tx, taskId, actor, 'Removed from the plan')
      }
      await tx.insert(planTasks).values([
        ...proposed.tasks.map((task, position) => ({ planId, key: task.key, taskId: ids.get(task.key)!, change: changes.get(task.key) ?? 'added', position })),
        ...[...existing.keys()].filter(key => !ids.has(key)).map((key, i) => ({ planId, key, taskId: null, change: 'removed' as const, position: proposed.tasks.length + i }))
      ])
      await tx.insert(planMessages).values({ sessionId: session.id, role: 'pm', kind: 'message', text: proposed.summary || `Proposed plan v${row!.version}: ${proposed.title}`, planId, runId })
      await tx.insert(auditLog).values({ projectId: project.id, actor, action: 'plan.proposed', detail: { planId, version: row!.version, tasks: proposed.tasks.length } })
      return row!
    })

    const full = await this.toPlan(plan)
    this.#d.events.publish({ type: 'plan.updated', plan: full })
    const epic = (await listEpics(db, project)).find(e => e.id === plan.epicId)
    if (epic) this.#d.events.publish({ type: 'epic.updated', epic })
    const [message] = await db.select().from(planMessages).where(eq(planMessages.planId, plan.id))
    if (message) this.#d.events.publish({ type: 'plan.message', message: toMessage(message) })
    for (const t of full.tasks) {
      if (t.taskId) this.#d.events.publish({ type: 'task.updated', task: await loadTask(db, t.taskId) })
    }
    return { ok: true, planId: plan.id, version: plan.version, tasks: full.tasks.map(t => ({ key: t.key, ref: t.ref, change: t.change })), message: 'The plan is saved and shown to the human for approval. Tell them what you proposed and why.' }
  }

  // Approve plan (design/plan.md): human only. Its Drafts go to the board
  // (Ready) or to the Backlog for later or for refining.
  // `via` is the PM run that carried out the human's say-so in chat
  async approve(planId: string, actor: Actor, to: 'ready' | 'backlog' = 'ready', via: { runId: string } | null = null): Promise<Plan> {
    if (actor.kind !== 'human') throw new ApiFailure(409, { code: 'transition_rejected', reason: { code: 'actor_not_allowed', actor: null, event: 'approve' } })
    const { db } = this.#d
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId))
    if (!plan) throw notFound()
    if (plan.status !== 'proposed') throw new ApiFailure(409, { code: 'conflict', constraint: `plan_${plan.status}` })
    const items = await db.select().from(planTasks).where(and(eq(planTasks.planId, planId), ne(planTasks.change, 'removed')))
    for (const item of items) {
      if (!item.taskId) continue
      const [row] = await db.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.id, item.taskId), isNull(tasks.deletedAt)))
      if (row?.status === 'draft') await transitionTask(db, item.taskId, { type: to === 'ready' ? 'approve' : 'accept' }, actor)
      // Plans proposed before Drafts existed put their tasks in Backlog
      else if (row?.status === 'backlog' && to === 'ready') await transitionTask(db, item.taskId, { type: 'approve' }, actor)
    }
    await db.update(plans).set({ status: 'approved', approvedBy: actor, approvedAt: new Date() }).where(eq(plans.id, planId))
    await db.insert(auditLog).values({ projectId: plan.projectId, actor, action: 'plan.approved', detail: { planId, version: plan.version, to, ...(via && { viaPmRun: via.runId }) } })
    const full = await this.toPlan((await db.select().from(plans).where(eq(plans.id, planId)))[0]!)
    this.#d.events.publish({ type: 'plan.updated', plan: full })
    for (const t of full.tasks) {
      if (t.taskId) this.#d.events.publish({ type: 'task.updated', task: await loadTask(db, t.taskId) })
    }
    this.#d.events.publish({ type: 'plan.session', session: await this.#toSession(await this.#session(plan.sessionId)) })
    return full
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async toPlan(row: PlanRow): Promise<Plan> {
    const { db } = this.#d
    const [project] = await db.select().from(projects).where(eq(projects.id, row.projectId))
    const items = await db.select({ item: planTasks, task: tasks }).from(planTasks).leftJoin(tasks, eq(tasks.id, planTasks.taskId))
      .where(eq(planTasks.planId, row.id)).orderBy(asc(planTasks.position))
    const ids = items.map(i => i.task?.id).filter((id): id is string => Boolean(id))
    const criteria = ids.length > 0 ? await db.select({ taskId: acceptanceCriteria.taskId }).from(acceptanceCriteria).where(inArray(acceptanceCriteria.taskId, ids)) : []
    const deps = ids.length > 0
      ? await db.select({ taskId: taskDependencies.taskId, number: tasks.number }).from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId)).where(inArray(taskDependencies.taskId, ids))
      : []
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
      tasks: items.map(({ item, task }) => ({
        key: item.key,
        change: item.change,
        taskId: task?.id ?? null,
        ref: task && project ? taskRef(project.prefix, task.number) : null,
        title: task?.title ?? item.key,
        status: task?.status ?? null,
        criteriaCount: criteria.filter(c => c.taskId === task?.id).length,
        dependsOn: deps.filter(d => d.taskId === task?.id).map(d => taskRef(project!.prefix, d.number))
      })),
      createdAt: row.createdAt.toISOString()
    }
  }

  async #proposedTasksOf(plan: PlanRow, project: ProjectRow): Promise<ProposedTask[]> {
    const full = await this.toPlan(plan)
    const result: ProposedTask[] = []
    for (const item of full.tasks) {
      if (item.change === 'removed' || !item.taskId) continue
      const task = await loadTask(this.#d.db, item.taskId).catch(() => null)
      if (!task) continue
      const keys = new Map(full.tasks.filter(t => t.ref).map(t => [t.ref!, t.key]))
      result.push({
        key: item.key,
        title: task.title,
        description: richTextToMarkdown(task.description),
        type: task.type,
        priority: task.priority,
        humanReview: task.humanReview,
        acceptanceCriteria: task.acceptanceCriteria.map(c => c.text),
        dependsOn: task.dependsOn.map(ref => keys.get(ref) ?? ref)
      })
    }
    void project
    return result
  }

  async #session(sessionId: string): Promise<SessionRow> {
    const [row] = await this.#d.db.select().from(planSessions).where(eq(planSessions.id, sessionId))
    if (!row) throw notFound()
    return row
  }

  async #taskIdByRef(project: ProjectRow, ref: string): Promise<string> {
    const match = new RegExp(`^${project.prefix}-(\\d+)$`, 'i').exec(ref.trim())
    if (!match) throw new ToolError(`${ref} isn't a task in ${project.name} (refs look like ${project.prefix}-12)`)
    return findTaskId(this.#d.db, project.id, Number(match[1])).catch(() => {
      throw new ToolError(`${ref} doesn't exist`)
    })
  }

  // The conversation so far, for reseeding a lost session (D9)
  async #history(sessionId: string): Promise<{ role: string, text: string }[]> {
    const rows = await this.#d.db.select().from(planMessages).where(eq(planMessages.sessionId, sessionId)).orderBy(asc(planMessages.createdAt))
    return rows.map(m => ({ role: m.role === 'human' ? 'Human' : m.kind === 'question' ? 'PM (question)' : 'PM', text: m.text }))
  }

  async #toSession(row: SessionRow, activeRunId?: string | null): Promise<PlanSession> {
    const { db } = this.#d
    const [last] = await db.select().from(planMessages).where(eq(planMessages.sessionId, row.id)).orderBy(desc(planMessages.createdAt)).limit(1)
    const [proposed] = await db.select({ id: plans.id }).from(plans).where(and(eq(plans.sessionId, row.id), eq(plans.status, 'proposed'))).limit(1)
    let runId = activeRunId ?? null
    if (activeRunId === undefined) {
      const [active] = await db.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.role, 'pm'), eq(runs.projectId, row.projectId), inArray(runs.state, ['queued', 'starting', 'running'])))
      runId = active?.id ?? null
    }
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      preview: last?.text.slice(0, 160) ?? '',
      unread: row.unread,
      status: proposed ? 'needs_approval' : last?.kind === 'question' ? 'question' : 'none',
      activeRunId: runId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }
  }
}

function toMessage(row: typeof planMessages.$inferSelect): PlanMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as 'human' | 'pm',
    kind: row.kind as PlanMessage['kind'],
    text: row.text,
    planId: row.planId,
    runId: row.runId,
    createdAt: row.createdAt.toISOString()
  }
}

function titleFrom(text: string): string {
  const line = text.split('\n')[0]!.trim()
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New session'
}
