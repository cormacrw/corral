import { EVIDENCE_KINDS, type GlobalStatus, type OutcomeReport, type RunEvent, type RunExit, type RunJob, type RunnerMessage } from '@corral/contracts'
import {
  ACTIVE_RUN_STATES,
  transition,
  taskRef,
  richTextToMarkdown,
  type Actor,
  type RunOutcome,
  type RunState
} from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm'
import { z } from 'zod'
import { listTaskAttachments, readProjectAttachment } from './attachments.ts'
import type { BlobStore } from './blob-store.ts'
import { claimNextTask, type Claim } from './claim.ts'
import { ApiFailure } from './errors.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import { slugify } from './projects.ts'
import { developerPrompt, reviewerPrompt } from './prompts.ts'
import type { RunnerHandlers, RunnerHub } from './runner-hub.ts'
import { MergeOrchestrator } from './merge.ts'
import type { PlanService } from './plan.ts'
import { getRun, listAgents, listEvidence } from './runs.ts'
import { applyTransition, deleteTaskRows, loadTask, lockTask, toTaskState, type ProjectRow, type TaskRow } from './tasks.ts'
import type { Transcripts } from './transcripts.ts'

const { acceptanceCriteria, agents, auditLog, comments, evidence, projects, reviews, runs, settings, tasks } = schema
type PlanSessionRow = typeof schema.planSessions.$inferSelect

const server: Actor = { kind: 'system', component: 'server' }

type RunRow = typeof runs.$inferSelect
type AgentRow = typeof agents.$inferSelect

interface RunContext {
  run: RunRow
  agent: AgentRow
  project: ProjectRow
  task: TaskRow | null
}

export interface OrchestratorDeps {
  db: Database
  events: EventBus
  runner: RunnerHub
  github: GitHubClient
  blobs: BlobStore
  transcripts: Transcripts
  // Where people open Corral, for links in PR bodies
  publicUrl: string
  now?: () => Date
}

// How long to wait after a usage limit with no known reset time (D3)
const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000
const RUN_TIMEOUT_SECONDS = 60 * 60
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024

const reportSchema = z.object({
  outcome: z.string(),
  summary: z.string().trim().min(1, 'Add a summary'),
  criteria: z.array(z.object({ criterionId: z.string(), met: z.boolean(), note: z.string().default('') })).optional(),
  headSha: z.string().optional()
})

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/
// Text evidence is returned inline up to this size
const MAX_INLINE_TEXT = 64 * 1024

const evidenceSchema = z.object({
  criterionId: z.string().uuid().nullable().default(null),
  kind: z.enum(EVIDENCE_KINDS),
  note: z.string().default(''),
  fileName: z.string().min(1),
  contentType: z.string().min(1),
  dataBase64: z.string()
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Thrown back to the agent as a tool error, in words it can act on
class ToolError extends Error {}

// Drives runs (flows.md §2): claims work and assigns it to the runner, keeps
// leases alive from heartbeats, reconciles lost runs, and handles every
// agent tool call. Every call from a run is fenced by its lease epoch.
export class Orchestrator implements RunnerHandlers {
  #d: OrchestratorDeps
  #timer: NodeJS.Timeout | null = null
  #scheduling: Promise<void> | null = null
  #again = false
  #stopped = false
  #updating = false
  readonly merges: MergeOrchestrator
  // Set once the plan service exists (it needs the orchestrator to start runs)
  plans: PlanService | null = null

  constructor(deps: OrchestratorDeps) {
    this.#d = deps
    this.merges = new MergeOrchestrator({
      db: deps.db,
      events: deps.events,
      github: deps.github,
      runner: deps.runner,
      ...(deps.now && { now: deps.now })
    })
  }

  // A PM turn (D9): a run with no task and no lease, fenced by its own epoch.
  // It waits as `queued`, holding its job, until the PM has a free slot (D13).
  async startPmRun(session: PlanSessionRow, job: Omit<RunJob, 'runId' | 'runNumber' | 'leaseEpoch' | 'runtime'>): Promise<string> {
    const { db } = this.#d
    if (this.#stopped) throw new ApiFailure(409, { code: 'conflict', constraint: 'corral_stopped' })
    if (this.#updating) throw new ApiFailure(503, { code: 'corral_updating' })
    const [pm] = await db.select().from(agents).where(eq(agents.role, 'pm')).orderBy(asc(agents.createdAt)).limit(1)
    if (!pm) throw new ApiFailure(409, { code: 'conflict', constraint: 'no_pm_agent' })
    if (pm.paused || (pm.pausedUntil && pm.pausedUntil > this.#now())) throw new ApiFailure(409, { code: 'conflict', constraint: 'pm_paused' })
    const [run] = await db.insert(runs).values({
      agentId: pm.id, projectId: job.projectId, taskId: null, role: 'pm', leaseEpoch: 1, planSessionId: session.id, pmJob: job, queuedAt: this.#now()
    }).returning()
    const ctx = await this.#load(run!.id)
    if (!ctx) throw new Error('PM run vanished')
    await this.#publish(ctx)
    await this.#startPmTurns()
    return run!.id
  }

  // Sends waiting PM turns to the runner, oldest first, while the PM's
  // concurrency allows. A waiting turn is `queued` with its job still held.
  async #startPmTurns(): Promise<void> {
    const { db, runner } = this.#d
    if (!runner.online || this.#stopped || this.#updating) return
    const due = await db.transaction(async (tx) => {
      const pmAgents = await tx.select().from(agents).where(eq(agents.role, 'pm')).orderBy(asc(agents.createdAt)).for('update')
      const picked: { id: string, job: Omit<RunJob, 'runId' | 'runNumber' | 'leaseEpoch'> }[] = []
      for (const agent of pmAgents) {
        if (agent.paused || (agent.pausedUntil && agent.pausedUntil > this.#now())) continue
        const active = await tx.select({ id: runs.id }).from(runs)
          .where(and(eq(runs.agentId, agent.id), inArray(runs.state, [...ACTIVE_RUN_STATES]), isNull(runs.pmJob)))
        const free = agent.concurrency - active.length
        if (free <= 0) continue
        const waiting = await tx.select({ id: runs.id, job: runs.pmJob }).from(runs)
          .where(and(eq(runs.agentId, agent.id), eq(runs.state, 'queued'), isNotNull(runs.pmJob)))
          .orderBy(asc(runs.queuedAt), asc(runs.number)).limit(free)
        for (const w of waiting) {
          await tx.update(runs).set({ pmJob: null }).where(eq(runs.id, w.id))
          // The runtime is the agent's that takes the turn, not whoever queued it
          picked.push({ id: w.id, job: { ...w.job as Omit<RunJob, 'runId' | 'runNumber' | 'leaseEpoch' | 'runtime'>, runtime: agent.runtime } })
        }
      }
      return picked
    })
    for (const { id, job } of due) {
      const ctx = await this.#load(id)
      if (!ctx) continue
      if (!runner.send({ type: 'run.assign', job: { ...job, runId: id, runNumber: ctx.run.number, leaseEpoch: ctx.run.leaseEpoch! } })) {
        const error = 'The runner went offline before the turn started'
        await this.#endRun(ctx, { state: 'interrupted', error })
        if (ctx.run.planSessionId) await this.plans?.onRunEnded(ctx.run.planSessionId, id, null, error)
      }
      await this.#publish(ctx)
    }
  }

  // Reads the kill switch; called once at startup
  async init(): Promise<void> {
    const [row] = await this.#d.db.select().from(settings).where(eq(settings.key, 'stopped'))
    this.#stopped = row?.value === true
    this.merges.stopped = this.#stopped
  }

  get stopped(): boolean {
    return this.#stopped
  }

  get status(): GlobalStatus {
    return { stopped: this.#stopped, updating: this.#updating }
  }

  // The update hold (scripts/deploy): like the kill switch, nothing new
  // starts, but running work finishes. Returns how much is still running, so
  // the deploy can call it until that reaches zero. Kept in memory: the
  // redeployed server starts without it.
  async holdForUpdate(): Promise<number> {
    if (!this.#updating) {
      this.#updating = true
      this.merges.stopped = true
      this.#d.events.publish({ type: 'global.status', status: this.status })
    }
    // A pass that began before the hold may still be claiming
    await this.#scheduling
    // PM turns still waiting for a slot keep their job and start after the update
    const live = await this.#d.db.select({ id: runs.id }).from(runs).where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), isNull(runs.pmJob)))
    return live.length + this.merges.inFlight
  }

  releaseUpdate(): void {
    if (!this.#updating) return
    this.#updating = false
    this.merges.stopped = this.#stopped
    this.#d.events.publish({ type: 'global.status', status: this.status })
    this.poke()
  }

  // The kill switch (PRD §7.11): nothing new starts, and every live run is
  // stopped. Resuming lets the scheduler carry on; stopped runs retry.
  async stopAll(actor: Actor): Promise<void> {
    await this.#setStopped(true, actor)
    const live = await this.#d.db.select({ id: runs.id }).from(runs).where(inArray(runs.state, [...ACTIVE_RUN_STATES]))
    for (const { id } of live) {
      const ctx = await this.#load(id)
      if (!ctx) continue
      this.#d.runner.send({ type: 'run.stop', runId: id, reason: 'Corral was stopped' })
      await this.#endRun(ctx, { state: 'interrupted', error: 'Stopped: Corral was stopped' })
      await this.#publish(ctx)
    }
  }

  async resumeAll(actor: Actor): Promise<void> {
    await this.#setStopped(false, actor)
    this.poke()
  }

  async #setStopped(stopped: boolean, actor: Actor): Promise<void> {
    this.#stopped = stopped
    this.merges.stopped = stopped || this.#updating
    await this.#d.db.insert(settings).values({ key: 'stopped', value: stopped }).onConflictDoUpdate({ target: settings.key, set: { value: stopped, updatedAt: this.#now() } })
    await this.#d.db.insert(auditLog).values({ actor, action: stopped ? 'corral.stopped' : 'corral.resumed', detail: {} })
    this.#d.events.publish({ type: 'global.status', status: this.status })
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date()
  }

  start(intervalMs = 15_000): void {
    this.#timer = setInterval(() => void this.tick(), intervalMs)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  async tick(): Promise<void> {
    await this.sweepLeases()
    await this.merges.tick().catch(error => console.error('Merge pass failed', error))
    await this.schedule()
  }

  // Asks for a scheduling pass soon; passes never overlap
  poke(): void {
    void this.schedule()
  }

  async schedule(): Promise<void> {
    if (this.#scheduling) {
      this.#again = true
      return this.#scheduling
    }
    this.#scheduling = (async () => {
      do {
        this.#again = false
        await this.#schedulePass().catch(error => console.error('Scheduling failed', error))
      } while (this.#again)
    })().finally(() => {
      this.#scheduling = null
    })
    return this.#scheduling
  }

  async #schedulePass(): Promise<void> {
    const { db, runner } = this.#d
    if (!runner.online || this.#stopped || this.#updating) return
    // PM turns aren't claimed; they run when the human writes (D9), and
    // only wait here for one of the PM's slots
    await this.#startPmTurns()
    const workers = await db.select().from(agents).where(ne(agents.role, 'pm')).orderBy(asc(agents.createdAt))
    for (const agent of workers) {
      for (let claim = await claimNextTask(db, agent.id, this.#now()); claim; claim = await claimNextTask(db, agent.id, this.#now())) {
        await this.#assign(claim)
        if (this.#stopped || this.#updating) return
      }
    }
  }

  async #assign(claim: Claim): Promise<void> {
    const ctx = await this.#load(claim.runId)
    if (!ctx?.task) return
    const job = ctx.run.role === 'reviewer' ? await this.#reviewerJob(ctx) : await this.#developerJob(ctx)
    if (!this.#d.runner.send({ type: 'run.assign', job })) {
      await this.#endRun(ctx, { state: 'interrupted', error: 'The runner went offline before the run started' })
    }
    await this.#publish(ctx)
  }

  async #developerJob(ctx: RunContext): Promise<RunJob> {
    const { db } = this.#d
    let task = ctx.task!
    const ref = taskRef(ctx.project.prefix, task.number)
    if (!task.branch) {
      const branch = `corral/${ref.toLowerCase()}-${slugify(task.title).slice(0, 40).replace(/-+$/, '')}`
      ;[task] = await db.update(tasks).set({ branch }).where(eq(tasks.id, task.id)).returning() as [TaskRow]
    }
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const notes = await this.#comments(task.id)
    const attached = await listTaskAttachments(db, ctx.project.id, task.description, notes)
    return {
      runId: ctx.run.id,
      runNumber: ctx.run.number,
      leaseEpoch: ctx.run.leaseEpoch!,
      role: 'developer',
      runtime: ctx.agent.runtime,
      projectId: ctx.project.id,
      repository: ctx.project.repository,
      defaultBranch: ctx.project.defaultBranch,
      taskId: task.id,
      taskRef: ref,
      branch: task.branch,
      headSha: task.headSha,
      planSessionId: null,
      agentSessionId: null,
      fallbackPrompt: null,
      model: null,
      timeoutSeconds: RUN_TIMEOUT_SECONDS,
      prompt: developerPrompt({
        ref,
        title: task.title,
        description: task.description,
        branch: task.branch!,
        defaultBranch: ctx.project.defaultBranch,
        reviewRounds: task.reviewRounds,
        reviewRoundCap: ctx.project.reviewRoundCap,
        criteria: criteria.map(c => ({ id: c.id, text: c.text })),
        comments: notes,
        attachments: attached
      }, ctx.agent.name)
    }
  }

  // flows.md step 6: the reviewer checks out the submitted commit
  async #reviewerJob(ctx: RunContext): Promise<RunJob> {
    const { db } = this.#d
    const task = ctx.task!
    const ref = taskRef(ctx.project.prefix, task.number)
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const items = (await listEvidence(db, task.id)).filter(e => e.round === task.reviewRounds)
    const [previous] = await db.select().from(reviews).where(eq(reviews.taskId, task.id)).orderBy(desc(reviews.createdAt)).limit(1)
    const notes = await this.#comments(task.id)
    const attached = await listTaskAttachments(db, ctx.project.id, task.description, notes)
    return {
      runId: ctx.run.id,
      runNumber: ctx.run.number,
      leaseEpoch: ctx.run.leaseEpoch!,
      role: 'reviewer',
      runtime: ctx.agent.runtime,
      projectId: ctx.project.id,
      repository: ctx.project.repository,
      defaultBranch: ctx.project.defaultBranch,
      taskId: task.id,
      taskRef: ref,
      branch: task.branch,
      headSha: task.headSha,
      planSessionId: null,
      agentSessionId: null,
      fallbackPrompt: null,
      model: null,
      timeoutSeconds: RUN_TIMEOUT_SECONDS,
      prompt: reviewerPrompt({
        ref,
        title: task.title,
        description: task.description,
        branch: task.branch!,
        defaultBranch: ctx.project.defaultBranch,
        reviewRounds: task.reviewRounds,
        reviewRoundCap: ctx.project.reviewRoundCap,
        criteria: criteria.map(c => ({ id: c.id, text: c.text })),
        comments: notes,
        attachments: attached,
        headSha: task.headSha!,
        prUrl: task.prUrl,
        evidence: items.map(e => ({ id: e.id, criterionId: e.criterionId, kind: e.kind, note: e.note, fileName: e.fileName })),
        previousFeedback: previous ? feedbackComment(previous.summary, previous.criteria, criteria) : null
      }, ctx.agent.name)
    }
  }

  async #comments(taskId: string) {
    const rows = await this.#d.db.select().from(comments).where(eq(comments.taskId, taskId)).orderBy(asc(comments.createdAt))
    return rows.map(c => ({ author: actorLabel(c.author), body: c.body, pinned: c.pinned, createdAt: c.createdAt }))
  }

  // ── Leases and reconciliation ──────────────────────────────────────────────

  // Expired leases: the runner stopped heartbeating (e.g. the laptop slept).
  // The run is Interrupted, not Failed, and the task waits for a retry (D10).
  async sweepLeases(): Promise<void> {
    const expired = await this.#d.db.select({ runId: tasks.leaseRunId }).from(tasks)
      .where(and(isNotNull(tasks.leaseRunId), lt(tasks.leaseExpiresAt, this.#now())))
    for (const { runId } of expired) {
      const ctx = runId ? await this.#load(runId) : null
      if (!ctx) continue
      await this.#endRun(ctx, { state: 'interrupted', error: 'Lease expired: no heartbeat from the runner' })
      this.#d.runner.send({ type: 'run.stop', runId: ctx.run.id, reason: 'Lease expired' })
      await this.#publish(ctx)
    }
  }

  async onConnected(activeRuns: { runId: string, leaseEpoch: number }[]): Promise<void> {
    const { db, runner } = this.#d
    // Runs the server thinks are live but the runner doesn't have were lost
    // when the runner restarted
    const live = await db.select().from(runs).where(inArray(runs.state, [...ACTIVE_RUN_STATES]))
    for (const run of live) {
      // A PM turn waiting for a slot was never sent
      if (run.pmJob !== null) continue
      if (activeRuns.some(a => a.runId === run.id && a.leaseEpoch === run.leaseEpoch)) continue
      const ctx = await this.#load(run.id)
      if (!ctx) continue
      await this.#endRun(ctx, { state: 'interrupted', error: 'The runner restarted during the run' })
      await this.#publish(ctx)
    }
    // Runs the runner has but the server no longer recognises must stop
    for (const active of activeRuns) {
      if (!(await this.#fenced(active.runId, active.leaseEpoch))) {
        runner.send({ type: 'run.stop', runId: active.runId, reason: 'The server no longer recognises this run' })
      }
    }
    this.poke()
  }

  async onHeartbeat(activeRuns: { runId: string, leaseEpoch: number }[]): Promise<void> {
    const now = this.#now()
    for (const active of activeRuns) {
      const ctx = await this.#fenced(active.runId, active.leaseEpoch)
      if (!ctx) {
        this.#d.runner.send({ type: 'run.stop', runId: active.runId, reason: 'This run no longer holds its lease' })
        continue
      }
      if (ctx.task) {
        await this.#d.db.update(tasks).set({
          leaseHeartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + 15 * 60 * 1000)
        }).where(and(eq(tasks.id, ctx.task.id), eq(tasks.leaseRunId, ctx.run.id), eq(tasks.leaseEpoch, active.leaseEpoch)))
      }
    }
  }

  async onDisconnected(): Promise<void> {
    // Nothing yet: leases expire on their own if the runner doesn't come back
  }

  // ── Run lifecycle ──────────────────────────────────────────────────────────

  async onRunMessage(message: Extract<RunnerMessage, { type: 'run.started' | 'run.events' | 'run.ended' }>): Promise<void> {
    const { db, events, transcripts } = this.#d
    if (message.type === 'run.events') {
      // Transcript lines are kept even from a stale run: they're history, not writes
      await transcripts.append(message.runId, message.events)
      events.publish({ type: 'run.events', runId: message.runId, events: message.events })
      const usage = message.events.filter((e): e is Extract<RunEvent, { type: 'usage' }> => e.type === 'usage').at(-1)
      if (usage) {
        await db.update(runs).set({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }).where(eq(runs.id, message.runId))
      }
      return
    }

    if (message.type === 'run.started') {
      const ctx = await this.#fenced(message.runId, message.leaseEpoch)
      if (!ctx) return
      await db.update(runs).set({ state: 'running', startedAt: this.#now(), agentSessionId: message.agentSessionId })
        .where(eq(runs.id, ctx.run.id))
      if (ctx.run.role === 'pm' && ctx.run.planSessionId) await this.plans?.onRunStarted(ctx.run.planSessionId, message.agentSessionId)
      await this.#publish(ctx)
      return
    }

    // run.ended
    const ctx = await this.#load(message.runId)
    if (!ctx) return
    const live = (ACTIVE_RUN_STATES as readonly RunState[]).includes(ctx.run.state) && ctx.run.leaseEpoch === message.leaseEpoch
    if (live && ctx.run.role === 'pm') await this.#pmExited(ctx, message.exit)
    else if (live) await this.#runExited(ctx, message.exit)
    const blob = await transcripts.finish(ctx.run.id)
    if (blob) await db.update(runs).set({ transcriptBlob: blob }).where(eq(runs.id, ctx.run.id))
    await this.#publish(ctx)
    this.poke()
  }

  // A PM turn has no outcome to report: its reply is the last thing it said
  async #pmExited(ctx: RunContext, exit: RunExit): Promise<void> {
    const events = await this.#d.transcripts.read(ctx.run.id, null)
    const reply = events.filter((e): e is Extract<RunEvent, { type: 'message' }> => e.type === 'message').at(-1)?.text ?? null
    let error: string | null = null
    switch (exit.kind) {
      case 'rate_limited': {
        const resetsAt = exit.resetsAt ? new Date(exit.resetsAt) : new Date(this.#now().getTime() + RATE_LIMIT_BACKOFF_MS)
        await this.#endRun(ctx, { state: 'completed', outcome: 'rate_limited', rateLimitResetAt: resetsAt, summary: 'Hit a usage limit' })
        await this.#d.db.update(agents).set({ pausedUntil: resetsAt }).where(eq(agents.id, ctx.agent.id))
        error = `${ctx.agent.name} hit a usage limit; try again after ${resetsAt.toISOString()}`
        break
      }
      case 'exited':
        if (exit.code === 0 || reply) {
          await this.#endRun(ctx, { state: 'completed', summary: reply })
        } else {
          error = `The PM exited with code ${exit.code}`
          await this.#endRun(ctx, { state: 'failed', outcome: 'failed', error })
        }
        break
      case 'stopped':
        await this.#endRun(ctx, { state: 'interrupted', error: 'Stopped' })
        error = 'The turn was stopped'
        break
      case 'timed_out':
        await this.#endRun(ctx, { state: 'failed', outcome: 'failed', error: 'The turn hit its time limit' })
        error = 'The turn hit its time limit'
        break
      case 'error':
        await this.#endRun(ctx, { state: 'failed', outcome: 'failed', error: exit.message })
        error = exit.message
        break
    }
    // A turn that ends without saying anything still answers the human, with
    // what the runner noted last (e.g. "The agent ended with an error: …")
    if (!reply && !error) {
      const note = events.filter((e): e is Extract<RunEvent, { type: 'system' }> => e.type === 'system').at(-1)?.text
      error = note ?? `${ctx.agent.name} finished without replying`
    }
    if (ctx.run.planSessionId) await this.plans?.onRunEnded(ctx.run.planSessionId, ctx.run.id, reply, error)
  }

  // The agent process ended without its outcome having been accepted
  async #runExited(ctx: RunContext, exit: RunExit): Promise<void> {
    const now = this.#now()
    switch (exit.kind) {
      case 'rate_limited': {
        // D3: a pause, not a failure. The agent waits until the limit resets.
        const resetsAt = exit.resetsAt ? new Date(exit.resetsAt) : new Date(now.getTime() + RATE_LIMIT_BACKOFF_MS)
        await this.#endRun(ctx, { state: 'completed', outcome: 'rate_limited', rateLimitResetAt: resetsAt, summary: 'Hit a usage limit' })
        await this.#d.db.update(agents).set({ pausedUntil: resetsAt }).where(eq(agents.id, ctx.agent.id))
        const agent = (await listAgents(this.#d.db)).find(a => a.id === ctx.agent.id)
        if (agent) this.#d.events.publish({ type: 'agent.updated', agent })
        return
      }
      case 'stopped':
        await this.#endRun(ctx, { state: 'interrupted', error: 'Stopped' })
        return
      default: {
        const error = exit.kind === 'timed_out'
          ? 'The run hit its time limit'
          : exit.kind === 'error' ? exit.message : `The agent exited (code ${exit.code}) without reporting an outcome`
        await this.#failRun(ctx, error)
      }
    }
  }

  // A failed run counts towards the failed-run cap (D10); at the cap the task fails
  async #failRun(ctx: RunContext, error: string): Promise<void> {
    await this.#d.db.transaction(async (tx) => {
      if (ctx.task) {
        const { task, project } = await lockTask(tx, ctx.task.id)
        if (task.leaseRunId === ctx.run.id && ['in_progress', 'agent_review'].includes(task.status)) {
          await applyTransition(tx, task, project, { type: 'run_failed' }, server, { event: 'run_failed', runId: ctx.run.id, error })
        }
      }
      await this.#endRunIn(tx, ctx, { state: 'failed', outcome: 'failed', error })
    })
  }

  async #endRun(ctx: RunContext, fields: Partial<typeof runs.$inferInsert> & { state: RunState }): Promise<void> {
    await this.#d.db.transaction(tx => this.#endRunIn(tx, ctx, fields))
  }

  // Ends the run and releases its lease, if it still holds one
  async #endRunIn(tx: Executor, ctx: RunContext, fields: Partial<typeof runs.$inferInsert> & { state: RunState }): Promise<void> {
    await tx.update(runs).set({ endedAt: this.#now(), pmJob: null, ...fields }).where(eq(runs.id, ctx.run.id))
    if (ctx.task) {
      await tx.update(tasks).set({ leaseRunId: null, leaseRole: null, leaseExpiresAt: null, leaseHeartbeatAt: null, updatedAt: this.#now() })
        .where(and(eq(tasks.id, ctx.task.id), eq(tasks.leaseRunId, ctx.run.id)))
    }
    await tx.insert(auditLog).values({
      projectId: ctx.project.id,
      taskId: ctx.task?.id ?? null,
      actor: server,
      action: 'run.ended',
      detail: { runId: ctx.run.id, runNumber: ctx.run.number, state: fields.state, outcome: fields.outcome ?? null, error: fields.error ?? null }
    })
  }

  // A human stops a run: the process tree is killed, the run is Interrupted
  // and the task is paused so the scheduler doesn't restart it (flows.md §3)
  async stopRun(runId: string, actor: Actor): Promise<void> {
    const ctx = await this.#load(runId)
    if (!ctx || !(ACTIVE_RUN_STATES as readonly RunState[]).includes(ctx.run.state)) throw new ApiFailure(409, { code: 'conflict', constraint: 'run_not_active' })
    this.#d.runner.send({ type: 'run.stop', runId, reason: 'Stopped by a human' })
    await this.#d.db.transaction(async (tx) => {
      await this.#endRunIn(tx, ctx, { state: 'interrupted', error: 'Stopped by a human' })
      if (ctx.task) await tx.update(tasks).set({ paused: true }).where(eq(tasks.id, ctx.task.id))
      await tx.insert(auditLog).values({ projectId: ctx.project.id, taskId: ctx.task?.id ?? null, actor, action: 'run.stopped', detail: { runId } })
    })
    await this.#publish(ctx)
  }

  // D10 "Deleting": stop the run, close the PR, delete the branch when safe,
  // then hide the task. Backlog tasks are simply removed.
  async deleteTask(taskId: string, actor: Actor, reason: string | null): Promise<void> {
    const { db, github, runner } = this.#d
    const [row] = await db.select({ task: tasks, project: projects }).from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId)).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    if (!row) throw new ApiFailure(404, { code: 'not_found' })
    const { task, project } = row
    if (task.status === 'merged') throw new ApiFailure(409, { code: 'conflict', constraint: 'merged_tasks_are_immutable' })

    if (task.leaseRunId) {
      const ctx = await this.#load(task.leaseRunId)
      if (ctx) {
        runner.send({ type: 'run.stop', runId: ctx.run.id, reason: 'The task was deleted' })
        await this.#endRun(ctx, { state: 'interrupted', error: 'The task was deleted' })
        this.#d.events.publish({ type: 'run.updated', run: await getRun(db, ctx.run.id) })
      }
    }
    if (task.prNumber) {
      // The PR keeps the pushed commits reachable, so the branch can go
      await github.closePullRequest(project.repository, task.prNumber).catch(error => console.error(`Closing PR #${task.prNumber} failed`, error))
      if (task.branch) await github.deleteBranch(project.repository, task.branch).catch(error => console.error(`Deleting ${task.branch} failed`, error))
    }
    await deleteTaskRows(db, taskId, actor, reason)
    // Worktrees with uncommitted work are kept (PRD §7.4)
    if (task.status !== 'backlog') void this.merges.cleanup(taskId)
    const dependents = await db.select({ id: tasks.id }).from(schema.taskDependencies)
      .innerJoin(tasks, eq(tasks.id, schema.taskDependencies.taskId)).where(eq(schema.taskDependencies.dependsOnId, taskId))
    for (const { id } of dependents) {
      const dependent = await loadTask(db, id).catch(() => null)
      if (dependent) this.#d.events.publish({ type: 'task.updated', task: dependent })
    }
    this.#d.events.publish({ type: 'task.deleted', taskId, projectId: project.id })
  }

  // design/project-settings.md, Danger zone: stop every run, then remove the
  // project and everything under it. GitHub is left alone: the repository,
  // branches and PRs stay.
  async deleteProject(projectId: string, actor: Actor): Promise<void> {
    const { db, runner } = this.#d
    // Nothing new is claimed while the runs stop
    await db.update(projects).set({ paused: true }).where(eq(projects.id, projectId))
    const live = await db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.projectId, projectId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    for (const { id } of live) {
      const ctx = await this.#load(id)
      if (!ctx) continue
      runner.send({ type: 'run.stop', runId: id, reason: 'The project was removed' })
      await this.#endRun(ctx, { state: 'interrupted', error: 'The project was removed' })
      this.#d.events.publish({ type: 'run.updated', run: await getRun(db, id) })
    }
    const worked = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, projectId), ne(tasks.status, 'backlog')))
    const project = await db.transaction(async (tx) => {
      // Tasks, epics, plans, plan sessions and runs go with it (onDelete: cascade)
      const [row] = await tx.delete(projects).where(eq(projects.id, projectId)).returning()
      if (!row) throw new ApiFailure(404, { code: 'not_found' })
      // Not tied to the project, or it would go too
      await tx.insert(auditLog).values({ projectId: null, actor, action: 'project.deleted', detail: { projectId, name: row.name, repository: row.repository } })
      return row
    })
    this.#d.events.publish({ type: 'project.deleted', projectId })
    // Worktrees with uncommitted work are kept (PRD §7.4). The runner has no
    // hook yet for removing a repository's clone.
    for (const { id } of worked) {
      void runner.request({ kind: 'cleanup_worktrees', repository: project.repository, taskId: id })
        .catch(error => console.error(`Worktree cleanup for task ${id} failed`, error))
    }
  }

  // ── Agent tools ────────────────────────────────────────────────────────────

  async onToolCall(message: Extract<RunnerMessage, { type: 'tool.call' }>): Promise<unknown> {
    const ctx = await this.#fenced(message.runId, message.leaseEpoch)
    if (!ctx) throw new ToolError('This run no longer holds its task: its lease expired or was given to another run. Stop working.')
    try {
      return await this.#tool(ctx, message.tool, message.input)
    } catch (error) {
      if (error instanceof ApiFailure && error.body.code === 'transition_rejected') {
        throw new ToolError(`Corral rejected this: ${JSON.stringify(error.body.reason)}`)
      }
      throw error
    }
  }

  async #tool(ctx: RunContext, tool: string, input: unknown): Promise<unknown> {
    const role = ctx.run.role
    const allowed: Record<string, readonly string[]> = {
      developer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'report_outcome'],
      reviewer: ['get_task', 'add_comment', 'get_evidence', 'get_attachment', 'report_outcome'],
      pm: ['list_tasks', 'get_task', 'get_run_outcomes', 'get_attachment', 'ask_question', 'propose_plan', 'approve_plan', 'flag_stale_docs']
    }
    if (!allowed[role]?.includes(tool)) throw new ToolError(`The ${role} can’t use ${tool}`)
    if (tool === 'get_attachment') return this.#getAttachment(ctx, z.object({ attachmentId: z.string() }).parse(input))
    if (role === 'pm') {
      if (!this.plans || !ctx.run.planSessionId) throw new ToolError('Planning is unavailable')
      return this.plans.tool(ctx.run.planSessionId, ctx.run.id, tool, input, this.#actor(ctx))
    }

    switch (tool) {
      case 'get_task':
        return this.#getTask(ctx)
      case 'add_comment': {
        const { body } = z.object({ body: z.string().trim().min(1) }).parse(input)
        await this.#d.db.insert(comments).values({ taskId: ctx.task!.id, author: this.#actor(ctx), body })
        return { ok: true }
      }
      case 'attach_evidence':
        return this.#attachEvidence(ctx, evidenceSchema.parse(input))
      case 'get_evidence':
        return this.#getEvidence(ctx, z.object({ evidenceId: z.string().optional() }).parse(input))
      case 'report_outcome':
        return this.#reportOutcome(ctx, reportSchema.parse(input) as OutcomeReport & { outcome: string })
    }
    throw new ToolError(`Unknown tool ${tool}`)
  }

  #actor(ctx: RunContext): Actor {
    return { kind: 'agent', role: ctx.run.role, runId: ctx.run.id }
  }

  async #getTask(ctx: RunContext) {
    const task = ctx.task!
    const criteria = await this.#d.db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const items = await listEvidence(this.#d.db, task.id)
    const notes = await this.#comments(task.id)
    return {
      ref: taskRef(ctx.project.prefix, task.number),
      title: task.title,
      status: task.status,
      description: richTextToMarkdown(task.description),
      branch: task.branch,
      reviewRound: task.reviewRounds,
      criteria: criteria.map(c => ({ id: c.id, text: c.text })),
      comments: notes.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })),
      attachments: await listTaskAttachments(this.#d.db, ctx.project.id, task.description, notes),
      evidence: items.map(e => ({ id: e.id, criterionId: e.criterionId, kind: e.kind, note: e.note, fileName: e.fileName, round: e.round }))
    }
  }

  async #attachEvidence(ctx: RunContext, input: z.infer<typeof evidenceSchema>) {
    const task = ctx.task!
    if (input.criterionId) {
      const [criterion] = await this.#d.db.select({ id: acceptanceCriteria.id }).from(acceptanceCriteria)
        .where(and(eq(acceptanceCriteria.id, input.criterionId), eq(acceptanceCriteria.taskId, task.id)))
      if (!criterion) throw new ToolError(`${input.criterionId} isn't one of this task's acceptance criteria`)
    }
    const data = Buffer.from(input.dataBase64, 'base64')
    if (data.length > MAX_EVIDENCE_BYTES) throw new ToolError('Evidence files are limited to 25 MB')
    const blob = await this.#d.blobs.put(data)
    const [row] = await this.#d.db.insert(evidence).values({
      taskId: task.id,
      criterionId: input.criterionId,
      runId: ctx.run.id,
      round: task.reviewRounds,
      kind: input.kind,
      note: input.note,
      blob,
      fileName: input.fileName,
      contentType: input.contentType,
      size: data.length
    }).returning()
    return { id: row!.id, sha256: blob }
  }

  // Evidence for the reviewer: a listing, or one item with its content.
  // Images come back as MCP image content so the reviewer can look at them.
  async #getEvidence(ctx: RunContext, input: { evidenceId?: string | undefined }) {
    const task = ctx.task!
    const items = await listEvidence(this.#d.db, task.id)
    if (!input.evidenceId) {
      return {
        round: task.reviewRounds,
        evidence: items.map(e => ({ id: e.id, criterionId: e.criterionId, kind: e.kind, note: e.note, fileName: e.fileName, contentType: e.contentType, size: e.size, round: e.round }))
      }
    }
    const item = items.find(e => e.id === input.evidenceId)
    if (!item) throw new ToolError(`${input.evidenceId} isn't evidence on this task`)
    const [row] = await this.#d.db.select({ blob: evidence.blob }).from(evidence).where(eq(evidence.id, item.id))
    const data = row ? await this.#d.blobs.get(row.blob) : null
    if (!data) throw new ToolError('The file for this evidence is missing')
    const meta = { id: item.id, criterionId: item.criterionId, kind: item.kind, note: item.note, fileName: item.fileName, contentType: item.contentType, size: item.size }
    if (IMAGE_TYPES.test(item.contentType)) {
      return { ...meta, images: [{ mimeType: item.contentType, dataBase64: Buffer.from(data).toString('base64') }] }
    }
    if (item.contentType.startsWith('text/') || item.contentType === 'application/json') {
      const text = new TextDecoder().decode(data.subarray(0, MAX_INLINE_TEXT))
      return { ...meta, text: data.length > MAX_INLINE_TEXT ? `${text}\n… (${data.length - MAX_INLINE_TEXT} more bytes)` : text }
    }
    return { ...meta, note: `${item.note} (binary ${item.contentType}; view it in Corral at ${this.#d.publicUrl}${item.url})`.trim() }
  }

  // An image from the task text, for any role, as MCP image content. Only
  // the run's own project: another project's id reads as unknown.
  async #getAttachment(ctx: RunContext, input: { attachmentId: string }) {
    const file = await readProjectAttachment(this.#d.db, this.#d.blobs, ctx.project.id, input.attachmentId)
    if (!file) throw new ToolError(`${input.attachmentId} isn't an attachment in this project`)
    const { data, ...meta } = file
    return { ...meta, images: [{ mimeType: meta.mimeType, dataBase64: Buffer.from(data).toString('base64') }] }
  }

  async #reportOutcome(ctx: RunContext, report: OutcomeReport & { outcome: string }): Promise<unknown> {
    if (ctx.run.role === 'reviewer') {
      switch (report.outcome) {
        case 'approved':
        case 'changes_requested':
          return this.#review(ctx, report, report.outcome)
        case 'failed':
          await this.#failRun(ctx, report.summary)
          this.#finished(ctx, 'Reported failed')
          return { ok: true, message: 'Recorded. You can stop now.' }
      }
      throw new ToolError('A reviewer reports approved, changes_requested or failed')
    }
    if (ctx.run.role === 'developer') {
      switch (report.outcome) {
        case 'pr_opened':
        case 'pr_updated':
          return this.#submit(ctx, report)
        case 'stuck':
          return this.#stuck(ctx, report.summary)
        case 'failed':
          await this.#failRun(ctx, report.summary)
          this.#finished(ctx, 'Reported failed')
          return { ok: true, message: 'Recorded. You can stop now.' }
      }
      throw new ToolError('A developer reports pr_opened, pr_updated, stuck or failed')
    }
    throw new ToolError(`Outcomes for ${ctx.run.role} runs aren't supported yet`)
  }

  // flows.md steps 6–7: record the verdict for this commit. Changes
  // requested goes through core (round cap → Blocked) and the feedback is
  // posted as a comment; an approval moves the task to Human review or
  // Ready to merge, where the merge orchestrator takes over.
  async #review(ctx: RunContext, report: OutcomeReport, verdict: 'approved' | 'changes_requested') {
    const { db } = this.#d
    const task = ctx.task!
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const verdicts = report.criteria ?? []
    const missing = criteria.filter(c => !verdicts.some(v => v.criterionId === c.id))
    if (missing.length > 0) {
      throw new ToolError(`Not recorded. Give a verdict for every criterion; missing: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}.`)
    }
    const unknown = verdicts.filter(v => !criteria.some(c => c.id === v.criterionId))
    if (unknown.length > 0) throw new ToolError(`Not recorded. Unknown criterion IDs: ${unknown.map(v => v.criterionId).join(', ')}.`)
    if (verdict === 'approved' && verdicts.some(v => !v.met)) {
      throw new ToolError('Not recorded. An approval needs every criterion met; otherwise report changes_requested.')
    }
    const kept = criteria.map(c => verdicts.find(v => v.criterionId === c.id)!).map(v => ({ criterionId: v.criterionId, met: v.met, note: v.note ?? '' }))
    // An approval is a short note; the per-criterion notes are kept on the
    // review and shown next to the evidence. Changes requested spells out
    // every criterion for the developer.
    const feedback = verdict === 'approved' ? `Approved: all ${kept.length} criteria met. ${report.summary.trim()}`.trim() : feedbackComment(report.summary, kept, criteria)

    await db.transaction(async (tx) => {
      const locked = await lockTask(tx, task.id)
      if (locked.task.leaseRunId !== ctx.run.id) throw new ToolError('This run lost its lease. Stop working.')
      const headSha = locked.task.headSha!
      await tx.insert(reviews).values({
        taskId: task.id, runId: ctx.run.id, round: locked.task.reviewRounds, headSha, verdict, summary: report.summary, criteria: kept, author: this.#actor(ctx)
      })
      await tx.insert(comments).values({ taskId: task.id, author: this.#actor(ctx), body: feedback })
      await tx.insert(auditLog).values({
        projectId: ctx.project.id, taskId: task.id, actor: this.#actor(ctx), action: 'review.recorded',
        detail: { runId: ctx.run.id, verdict, headSha, round: locked.task.reviewRounds, met: kept.filter(v => v.met).length, of: kept.length }
      })
      // Changes requested → the developer; approved → Human review when
      // flagged, otherwise Ready to merge (D10)
      await applyTransition(tx, locked.task, locked.project, { type: verdict === 'approved' ? 'review_approved' : 'changes_requested' }, server, { event: verdict === 'approved' ? 'review_approved' : 'changes_requested', runId: ctx.run.id, headSha })
      await this.#endRunIn(tx, ctx, { state: 'completed', outcome: verdict, summary: report.summary, headSha })
    })
    this.#finished(ctx, `Review recorded: ${verdict}`)
    return {
      ok: true,
      message: verdict === 'approved'
        ? 'Approval recorded. Corral handles human review, CI and the merge from here. You can stop now.'
        : 'Changes requested; your feedback was sent to the developer. You can stop now.'
    }
  }

  // Asks a human: the task becomes Blocked with the question as its reason (D11)
  async #stuck(ctx: RunContext, question: string) {
    await this.#d.db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, ctx.task!.id)
      await applyTransition(tx, task, project, { type: 'block', reason: question }, server, { event: 'stuck', runId: ctx.run.id })
      await this.#endRunIn(tx, ctx, { state: 'completed', outcome: 'stuck', summary: question })
    })
    this.#finished(ctx, 'Stuck: waiting on a human')
    return { ok: true, message: 'The task is Blocked until a human answers. You can stop now.' }
  }

  // flows.md step 5: validate the developer's submission, open or update the
  // PR, then move the task to Agent review
  async #submit(ctx: RunContext, report: OutcomeReport) {
    const { db, github } = this.#d
    const task = ctx.task!
    if (!report.headSha) throw new ToolError('There is no commit to submit. Commit your work, then report again.')

    const head = await github.branchHead(ctx.project.repository, task.branch!)
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const attached = await db.select({ criterionId: evidence.criterionId }).from(evidence)
      .where(and(eq(evidence.taskId, task.id), eq(evidence.round, task.reviewRounds)))
    const missing = criteria.filter(c => !attached.some(e => e.criterionId === c.id))

    // Check with core before touching GitHub, so a rejected outcome leaves no trace
    const check = transition(toTaskState(task), {
      type: 'submit',
      branchAtExpectedCommit: head === report.headSha,
      evidenceComplete: missing.length === 0
    }, server)
    if (!check.ok) {
      const problems = [
        head !== report.headSha ? `The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${report.headSha}.` : '',
        missing.length > 0 ? `No evidence yet for: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}.` : ''
      ].filter(Boolean)
      throw new ToolError(`Not submitted. ${problems.join(' ') || JSON.stringify(check.error)} Fix this and report again.`)
    }

    const ref = taskRef(ctx.project.prefix, task.number)
    const body = this.#prBody(ref, task.title, report.summary, criteria, attached)
    const existing = task.prNumber
      ? await github.getPullRequest(ctx.project.repository, task.prNumber)
      : await github.findOpenPullRequest(ctx.project.repository, task.branch!)
    let pr = existing && existing.state === 'open' ? existing : null
    if (pr) await github.updatePullRequest(ctx.project.repository, pr.number, { body })
    else pr = await github.openPullRequest(ctx.project.repository, { head: task.branch!, base: ctx.project.defaultBranch, title: `${ref}: ${task.title}`, body })

    await db.transaction(async (tx) => {
      const locked = await lockTask(tx, task.id)
      if (locked.task.leaseRunId !== ctx.run.id) throw new ToolError('This run lost its lease while submitting. Stop working.')
      await applyTransition(tx, locked.task, locked.project, {
        type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
      }, server, { event: report.outcome, runId: ctx.run.id, headSha: report.headSha, pr: pr.number })
      await tx.update(tasks).set({ headSha: report.headSha, prNumber: pr.number, prUrl: pr.url }).where(eq(tasks.id, task.id))
      await this.#endRunIn(tx, ctx, { state: 'completed', outcome: report.outcome as RunOutcome, summary: report.summary, headSha: report.headSha })
    })
    this.#finished(ctx, 'Outcome accepted')
    return { ok: true, pr: pr.url, message: `PR #${pr.number} is ready for review. You can stop now.` }
  }

  #prBody(ref: string, title: string, summary: string, criteria: { id: string, text: string }[], attached: { criterionId: string | null }[]): string {
    const link = `${this.#d.publicUrl}/tasks/${ref}`
    // Table cells can't hold newlines or bare pipes
    const cell = (text: string) => text.replace(/\s*\n\s*/g, ' ').replaceAll('|', '\\|')
    return [
      '## Summary',
      '',
      summary.trim(),
      '',
      '## Acceptance criteria',
      '',
      '| Criterion | Evidence |',
      '| --- | --- |',
      ...criteria.map((c) => {
        const n = attached.filter(e => e.criterionId === c.id).length
        return `| ${cell(c.text)} | ${n} item${n === 1 ? '' : 's'} |`
      }),
      '',
      `Screenshots, logs and the reviewer's verdicts are on the [evidence page](${link}?evidence=1).`,
      '',
      '---',
      '',
      `Corral task [${ref}: ${cell(title)}](${link})`
    ].join('\n')
  }

  // The outcome is recorded; the runner stops the agent's process tree
  #finished(ctx: RunContext, reason: string): void {
    this.#d.runner.send({ type: 'run.stop', runId: ctx.run.id, reason })
    void this.#publish(ctx).then(() => this.poke())
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async #load(runId: string): Promise<RunContext | null> {
    // IDs come from the runner; a malformed one is simply unknown
    if (!UUID.test(runId)) return null
    const [row] = await this.#d.db.select({ run: runs, agent: agents, project: projects, task: tasks })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .leftJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, runId))
    return row ?? null
  }

  // The run, if it's still live and still holds its lease at this epoch.
  // Anything from a stale run is ignored or rejected (fencing).
  async #fenced(runId: string, leaseEpoch: number): Promise<RunContext | null> {
    const ctx = await this.#load(runId)
    if (!ctx || ctx.run.leaseEpoch !== leaseEpoch) return null
    if (!(ACTIVE_RUN_STATES as readonly RunState[]).includes(ctx.run.state)) return null
    if (ctx.task && (ctx.task.leaseRunId !== runId || ctx.task.leaseEpoch !== leaseEpoch)) return null
    return ctx
  }

  async #publish(ctx: RunContext): Promise<void> {
    const { db, events } = this.#d
    events.publish({ type: 'run.updated', run: await getRun(db, ctx.run.id) })
    // A soft-deleted task has nothing left to show
    const task = ctx.task ? await loadTask(db, ctx.task.id).catch(() => null) : null
    if (task) events.publish({ type: 'task.updated', task })
  }
}

// The review as a comment the developer reads next round
export function feedbackComment(summary: string, verdicts: { criterionId: string, met: boolean, note: string }[], criteria: { id: string, text: string }[]): string {
  const lines = verdicts.map((v) => {
    const text = criteria.find(c => c.id === v.criterionId)?.text ?? v.criterionId
    return `- ${v.met ? '✅' : '❌'} ${text}${v.note ? ` — ${v.note}` : ''}`
  })
  return [summary.trim(), '', ...lines].join('\n').trim()
}

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'human': return 'Human'
    case 'agent': return actor.role === 'pm' ? 'PM' : actor.role === 'developer' ? 'Developer' : 'Reviewer'
    case 'system': return 'Corral'
  }
}
