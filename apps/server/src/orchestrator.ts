import { appendAudit, auditEvent } from './audit.ts'
import { EpicPullRequests, epicReviewContext } from './epic-prs.ts'
import { RUNNER_HEARTBEAT_MS, epicReviewReportSchema, evidenceKind, outcomeReportSchema, rebaseReviewReportSchema, RUNTIMES_TAKING_MESSAGES, type Comment, type GlobalStatus, type OutcomeReport, type RunEvent, type RunExit, type RunJob, type PmRunJob, type RunnerMessage, type RunnerRole } from '@corral/contracts'
import {
  ACTIVE_RUN_STATES,
  LEASE_DURATION_MS,
  feedbackSimilarity,
  nextDesignVersion,
  reviewFeedbackText,
  transition,
  humanCheckTally,
  type ReviewVerdict,
  taskRef,
  richTextToMarkdown,
  type Actor,
  type RunState
} from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm'
import { z } from 'zod'
import { listTaskAttachments, readProjectAttachment } from './attachments.ts'
import type { BlobStore } from './blob-store.ts'
import { claimNextTask, type Claim, type Place } from './claim.ts'
import { publishDependents } from './dependent-tasks.ts'
import { bundleHasRootIndex, DesignNotFound, readDesign } from './designs.ts'
import { ApiFailure } from './errors.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient, PullRequest } from './github.ts'
import { EpicBranchError, isEpicRebaseTask, taskBase } from './task-base.ts'
import { slugify } from './projects.ts'
import { designerPrompt, designerRevisionPrompt, developerPrompt, developerRevisionPrompt, reviewerPrompt, type PinnedDesign } from './prompts.ts'
import { runExitError, withLastActivity } from './run-exit.ts'
import { runEndValues, type RunEnd } from './run-lifecycle.ts'
import type { RunnerHandlers, RunnerHub } from './runner-hub.ts'
import { MergeOrchestrator } from './merge.ts'
import type { ReleaseNotes } from './deployments.ts'
import type { PlanService } from './plan.ts'
import { getRun, listAgents, listEvidence } from './runs.ts'
import { addComment, applyTransition, deleteTaskRows, loadTask, lockTask, toTaskState, type ProjectRow, type TaskContentEdit, type TaskRow } from './tasks.ts'
import type { Transcripts } from './transcripts.ts'
import { WorktreeSweep } from './worktree-sweep.ts'

const { acceptanceCriteria, agents, attachments, comments, designVersions, evidence, projects, reviews, runs, settings, taskDesignPins, tasks } = schema
type PlanSessionRow = typeof schema.planSessions.$inferSelect

const server: Actor = { kind: 'system', component: 'server' }

// Stops the task is retried after, which ask the runner to keep the run's work
const HUMAN_STOP = 'Stopped by a human'
const KILL_SWITCH_STOP = 'Stopped: Corral was stopped'
const KEEP_WORK_STOPS: ReadonlySet<string> = new Set([HUMAN_STOP, KILL_SWITCH_STOP])

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
// The developer's one-line work note, posted as a comment on every outcome
export const MAX_NOTE_LENGTH = 200
const NOTE_EXAMPLE = 'Rebased onto 6e67d6f; resolved conflict in docs/architecture.md keeping main’s SSE wording'

// A report that doesn't fit its schema comes back to the agent field by field
function parseReport<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const fields = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
  throw new ToolError(`Not reported. ${fields.join('. ')}. Fix this and report again.`)
}

// What the runner sends for submit_design (D20)
const designSchema = z.object({
  headSha: z.string().min(1),
  spec: z.string().trim().min(1, 'design.md is empty'),
  bundle: z.object({ dataBase64: z.string().min(1) }),
  screenshots: z.array(z.object({ fileName: z.string().min(1), contentType: z.string().regex(/^image\//), dataBase64: z.string().min(1) })).min(1, 'Add at least one screenshot')
})
const MAX_DESIGN_BYTES = 25 * 1024 * 1024

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/
// Text evidence is returned inline up to this size
const MAX_INLINE_TEXT = 64 * 1024

// A file, or a note on its own: written evidence for a criterion with
// nothing to show (D21)
const evidenceSchema = z.object({
  criterionId: z.string().uuid().nullable().default(null),
  kind: evidenceKind,
  note: z.string().default(''),
  fileName: z.string().min(1).optional(),
  contentType: z.string().min(1).optional(),
  dataBase64: z.string().optional()
}).superRefine((input, ctx) => {
  if (input.dataBase64 !== undefined) {
    if (input.kind === 'note') ctx.addIssue({ code: 'custom', message: 'A note is evidence without a file: leave out path, or pick the kind of the file' })
    if (!input.fileName || !input.contentType) ctx.addIssue({ code: 'custom', message: 'A file needs its fileName and contentType' })
    return
  }
  if (input.kind !== 'note') ctx.addIssue({ code: 'custom', path: ['path'], message: `Pass the path of the file to attach, or use kind "note" to explain in writing a criterion with nothing to show (${input.kind} needs a file)` })
  else if (!input.note.trim()) ctx.addIssue({ code: 'custom', path: ['note'], message: 'A note needs its text: explain how the criterion is met' })
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
  // Tasks an event made workable (approval, a pushed PR, a review): the
  // next pass may start them even for an agent inside its wake interval
  #urgent = new Set<string>()
  #stopped = false
  #updating = false
  #finishingUpdate = false
  #pmStarting: Promise<void> = Promise.resolve()
  // Picking a runner and recording the run on it happen one at a time, so
  // PM turns and claims never both take a runner's last slot
  #placing: Promise<unknown> = Promise.resolve()
  readonly epicPrs: EpicPullRequests
  readonly merges: MergeOrchestrator
  readonly sweep: WorktreeSweep
  // Set once the plan service exists (it needs the orchestrator to start runs)
  plans: PlanService | null = null
  releaseNotes: ReleaseNotes | null = null

  constructor(deps: OrchestratorDeps) {
    this.#d = deps
    this.epicPrs = new EpicPullRequests(deps)
    this.merges = new MergeOrchestrator({
      db: deps.db,
      events: deps.events,
      github: deps.github,
      runner: deps.runner,
      wake: ids => this.poke(ids),
      ...(deps.now && { now: deps.now })
    })
    this.sweep = new WorktreeSweep({ db: deps.db, runner: deps.runner, ...(deps.now && { now: deps.now }) })
  }

  // A PM turn (D9): a run with no task and no lease, fenced by its own epoch.
  // It starts right away; it only waits as `queued`, holding its job, while
  // the PM is paused, the runner can't take it, or an update is finishing (D13, D16).
  async startPmRun(session: PlanSessionRow, job: Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch'>): Promise<string> {
    const { db } = this.#d
    if (this.#stopped) throw new ApiFailure(409, { code: 'conflict', constraint: 'corral_stopped' })
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

  // Sends every waiting PM turn to the runner, oldest first. The PM has no
  // concurrency, since each session runs one turn at a time (D9, D13), so a
  // turn waits with its job held while paused, offline, or finishing an update.
  #startPmTurns(): Promise<void> {
    const next = this.#pmStarting.then(() => this.#dispatchPmTurns())
    this.#pmStarting = next.catch(() => {})
    return next
  }

  // Once workers and merges have drained, keep the phase latched until
  // release/restart. Held PM jobs must never make the deploy wait.
  async #updatePhase(): Promise<void> {
    if (!this.#updating || this.#finishingUpdate) return
    const workers = await this.#d.db.select({ id: runs.id }).from(runs)
      .where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), ne(runs.role, 'pm'))).limit(1)
    if (this.#updating && !workers.length && !this.merges.inFlight) this.#finishingUpdate = true
  }

  async #dispatchPmTurns(): Promise<void> {
    const { db, runner } = this.#d
    await this.#updatePhase()
    if (!runner.online || this.#stopped || this.#finishingUpdate) return
    const due = await this.#exclusive(() => db.transaction(async (tx) => {
      const pmAgents = await tx.select().from(agents).where(eq(agents.role, 'pm')).orderBy(asc(agents.createdAt)).for('update')
      const picked: { id: string, runnerId: string, note: string | null, job: Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch'> }[] = []
      for (const agent of pmAgents) {
        if (agent.paused || (agent.pausedUntil && agent.pausedUntil > this.#now())) continue
        const waiting = await tx.select({ id: runs.id, job: runs.pmJob, planSessionId: runs.planSessionId }).from(runs)
          .where(and(eq(runs.agentId, agent.id), eq(runs.state, 'queued'), isNotNull(runs.pmJob)))
          .orderBy(asc(runs.queuedAt), asc(runs.number))
        for (const w of waiting) {
          // The runtime is the session's (D18); a job queued before sessions
          // had one runs on the PM agent's, as it always did
          const held = w.job as Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch' | 'runtime'> & { runtime?: string }
          let job = { ...held, runtime: held.runtime ?? agent.runtime }
          // A Plan session stays on the runner of its earlier turns while it's
          // online: its warm process and session files are there
          const [previous] = w.planSessionId
            ? await tx.select({ runnerId: runs.runnerId, number: runs.number }).from(runs)
                .where(and(eq(runs.planSessionId, w.planSessionId), ne(runs.id, w.id), isNotNull(runs.runnerId)))
                .orderBy(desc(runs.number)).limit(1)
            : []
          const runnerId = await this.#pickRunner(tx, 'pm', job.runtime, previous?.runnerId ?? null)
          // No PM runner free: the turn keeps its job and waits
          if (!runnerId) continue
          let note: string | null = null
          if (previous && previous.runnerId !== runnerId && job.agentSessionId) {
            // Its runner is gone: cold-start a fresh session from the saved conversation
            job = { ...job, agentSessionId: null, prompt: job.fallbackPrompt ?? job.prompt, fallbackPrompt: null }
            note = `This session's earlier turns ran on ${this.#runnerName(previous.runnerId)}, which is offline: starting a fresh session on ${this.#runnerName(runnerId)} from the saved conversation`
          }
          await tx.update(runs).set({ pmJob: null, runnerId, runnerName: this.#d.runner.name(runnerId) }).where(eq(runs.id, w.id))
          picked.push({ id: w.id, runnerId, note, job })
        }
      }
      return picked
    }))
    for (const { id, runnerId, note, job } of due) {
      const ctx = await this.#load(id)
      if (!ctx) continue
      if (note) await this.#note(id, note)
      if (!runner.send({ type: 'run.assign', job: { ...job, runId: id, runNumber: ctx.run.number, leaseEpoch: ctx.run.leaseEpoch! } }, runnerId)) {
        const error = 'The runner went offline before the turn started'
        await this.#endRun(ctx, { state: 'interrupted', error })
        if (ctx.run.planSessionId) await this.plans?.onRunEnded(ctx.run.planSessionId, id, null, error)
      }
      await this.#publish(ctx)
    }
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#placing.then(fn)
    this.#placing = next.catch(() => {})
    return next
  }

  // The runner a run goes to: an online one that takes the role, has a
  // signed-in CLI for the runtime and a free slot, the emptiest first. A run
  // with a previous runner that's still online waits for that one.
  async #pickRunner(tx: Executor, role: RunnerRole, runtime: string, previous: string | null): Promise<string | null> {
    const fit = this.#d.runner.available().filter(r => r.roles.includes(role) && r.runtimes.includes(runtime))
    if (!fit.length) return null
    const busy = await tx.select({ runnerId: runs.runnerId, n: count() }).from(runs)
      .where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), inArray(runs.runnerId, fit.map(r => r.id))))
      .groupBy(runs.runnerId)
    const free = (id: string, slots: number) => slots - (busy.find(b => b.runnerId === id)?.n ?? 0)
    const sticky = previous ? fit.find(r => r.id === previous) : undefined
    if (sticky) return free(sticky.id, sticky.slots) > 0 ? sticky.id : null
    const best = fit.map(r => ({ id: r.id, free: free(r.id, r.slots) })).filter(r => r.free > 0)
      .sort((a, b) => b.free - a.free)[0]
    return best?.id ?? null
  }

  #runnerName(runnerId: string | null): string {
    const name = this.#d.runner.status().runners.find(r => r.id === runnerId)?.name
    return name ? `runner ${name}` : 'a runner this server no longer knows'
  }

  // A line in the run's transcript from Corral itself
  async #note(runId: string, text: string): Promise<void> {
    const events: RunEvent[] = [{ type: 'system', text }]
    await this.#d.transcripts.append(runId, events)
    this.#d.events.publish({ type: 'run.events', runId, events })
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

  // The update hold drains workers/merges while PM turns still start, then
  // queues new PM turns while active turns finish. Returns the busy count so
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
    await this.#pmStarting
    await this.#updatePhase()
    // PM turns still waiting for a slot keep their job and start after the update
    const live = await this.#d.db.select({ id: runs.id }).from(runs).where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), isNull(runs.pmJob)))
    return live.length + this.merges.inFlight
  }

  releaseUpdate(): void {
    if (!this.#updating) return
    this.#updating = false
    this.#finishingUpdate = false
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
      this.#d.runner.send({ type: 'run.stop', runId: id, reason: 'Corral was stopped', keepWork: true }, ctx.run.runnerId)
      await this.#endRun(ctx, { state: 'interrupted', error: KILL_SWITCH_STOP })
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
    await appendAudit(this.#d.db, { actor }, stopped ? auditEvent('corral.stopped', {}) : auditEvent('corral.resumed', {}))
    this.#d.events.publish({ type: 'global.status', status: this.status })
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date()
  }

  start(intervalMs = 15_000): void {
    this.#timer = setInterval(() => void this.tick(), intervalMs)
    this.sweep.start()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.sweep.stop()
  }

  async tick(): Promise<void> {
    await this.sweepLeases()
    await this.merges.tick().catch(error => console.error('Merge pass failed', error))
    await this.schedule()
  }

  // Asks for a scheduling pass soon; passes never overlap. Passing the tasks
  // an event is about lets them start right away despite a wake interval;
  // anything else (a run ending, a settings change, the kill switch's
  // resume) waits for it
  poke(taskIds: readonly string[] = []): void {
    void this.schedule(taskIds)
  }

  async schedule(taskIds: readonly string[] = []): Promise<void> {
    for (const id of taskIds) this.#urgent.add(id)
    if (this.#scheduling) {
      this.#again = true
      return this.#scheduling
    }
    this.#scheduling = (async () => {
      do {
        this.#again = false
        const urgent = [...this.#urgent]
        this.#urgent.clear()
        await this.#schedulePass(urgent).catch(error => console.error('Scheduling failed', error))
      } while (this.#again)
    })().finally(() => {
      this.#scheduling = null
    })
    return this.#scheduling
  }

  async #schedulePass(urgent: readonly string[]): Promise<void> {
    const { db, runner } = this.#d
    if (!runner.online || this.#stopped) return
    // PM turns aren't claimed; they run when the human writes (D9), and
    // only wait here while the PM was paused or the runner was away
    await this.#startPmTurns()
    if (this.#updating) return
    await this.epicPrs.reconcile()
    if (this.#stopped || this.#updating) return
    const workers = await db.select().from(agents).where(ne(agents.role, 'pm')).orderBy(asc(agents.createdAt))
    // Tasks whose run couldn't start wait for the next pass rather than
    // burning their failed-run cap in a tight loop
    const skip: string[] = []
    for (const agent of workers) {
      // An agent with a wake interval starts at most one task of its own
      // choosing per interval, counted from its last run however that one
      // started. Tasks an event is about start regardless.
      if (agent.role === 'reviewer' && (agent.wakeIntervalSeconds === null || await this.#awake(agent))) {
        const claimEpic = () => this.#exclusive(() => this.epicPrs.claim(agent.id, tx => this.#pickRunner(tx, 'reviewer', agent.runtime, null)))
        for (let job = await claimEpic(); job; job = await claimEpic()) {
          const ctx = await this.#load(job.runId)
          if (!ctx) break
          if (!runner.send({ type: 'run.assign', job }, ctx.run.runnerId)) {
            await this.#endRun(ctx, { state: 'interrupted', error: 'The runner went offline before the run started' })
            break
          }
          if (this.#stopped || this.#updating) return
          if (agent.wakeIntervalSeconds !== null) break
        }
      }
      let only = agent.wakeIntervalSeconds === null || (await this.#awake(agent)) ? undefined : urgent
      const place: Place = async (tx, task) => {
        const role: RunnerRole = agent.role === 'designer' ? 'design' : agent.role
        const previous = agent.role !== 'reviewer' ? await this.#previousAuthorRun(tx, task.id, agent.id, agent.role) : null
        return this.#pickRunner(tx, role, agent.runtime, previous?.runnerId ?? null)
      }
      const claimNext = () => this.#exclusive(() => claimNextTask(db, agent.id, this.#now(), only, skip, place))
      for (let claim = await claimNext(); claim; claim = await claimNext()) {
        if (!await this.#assign(claim)) skip.push(claim.taskId)
        if (this.#stopped || this.#updating) return
        if (agent.wakeIntervalSeconds !== null) only = urgent
      }
    }
  }

  // Whether the agent's wake interval has passed since its last run started
  async #awake(agent: AgentRow): Promise<boolean> {
    const [last] = await this.#d.db.select({ queuedAt: runs.queuedAt }).from(runs)
      .where(eq(runs.agentId, agent.id)).orderBy(desc(runs.queuedAt)).limit(1)
    return !last || this.#now().getTime() - last.queuedAt.getTime() >= agent.wakeIntervalSeconds! * 1000
  }

  // Whether the run was handed to the runner
  async #assign(claim: Claim): Promise<boolean> {
    if (claim.runnerId) await this.#d.db.update(runs).set({ runnerName: this.#d.runner.name(claim.runnerId) }).where(eq(runs.id, claim.runId))
    const ctx = await this.#load(claim.runId)
    if (!ctx?.task) return false
    let job: RunJob
    try {
      job = ctx.run.role === 'reviewer' ? await this.#reviewerJob(ctx) : ctx.run.role === 'designer' ? await this.#designerJob(ctx) : await this.#developerJob(ctx)
    } catch (error) {
      // Preparing the epic branch calls GitHub; the run fails straight away
      // with the cause instead of holding its lease until it expires
      if (!(error instanceof EpicBranchError)) throw error
      await this.#failRun(ctx, error.message)
      await this.#publish(ctx)
      return false
    }
    const sent = this.#d.runner.send({ type: 'run.assign', job }, ctx.run.runnerId)
    if (!sent) {
      await this.#endRun(ctx, { state: 'interrupted', error: 'The runner went offline before the run started' })
    }
    await this.#publish(ctx)
    return sent
  }

  async #developerJob(ctx: RunContext): Promise<RunJob> {
    return this.#authorJob(ctx, {
      branch: ref => `corral/${ref.toLowerCase()}-${slugify(ctx.task!.title).slice(0, 40).replace(/-+$/, '')}`,
      prompt: developerPrompt,
      revision: developerRevisionPrompt
    })
  }

  async #designerJob(ctx: RunContext): Promise<RunJob> {
    const [latest] = await this.#d.db.select({ version: designVersions.version, createdAt: designVersions.createdAt }).from(designVersions)
      .where(eq(designVersions.taskId, ctx.task!.id)).orderBy(desc(designVersions.version)).limit(1)
    return this.#authorJob(ctx, {
      branch: ref => `design/${ref}`,
      design: { version: latest?.version ?? null },
      prompt: designerPrompt,
      revision: task => latest ? designerRevisionPrompt(task, task.comments.filter(c => c.createdAt > latest.createdAt)) : designerPrompt(task, ctx.agent.name)
    })
  }

  async #authorJob(ctx: RunContext, author: {
    branch: (ref: string) => string
    design?: { version: number | null }
    prompt: typeof developerPrompt
    revision: typeof developerRevisionPrompt
  }): Promise<RunJob> {
    const { db } = this.#d
    let task = ctx.task!
    const ref = taskRef(ctx.project.prefix, task.number)
    // A spike delivers findings, not a PR (D19), so it never gets a branch.
    // A design is built on design/<ref>, pushed but never merged (D20).
    const baseBranch = await taskBase(db, task, ctx.project, this.#d.github)
    const spike = task.type === 'spike'
    if (!task.branch && !spike) {
      const branch = author.branch(ref)
      ;[task] = await db.update(tasks).set({ branch }).where(eq(tasks.id, task.id)).returning() as [TaskRow]
    }
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const notes = await this.#comments(task.id)
    const attached = await listTaskAttachments(db, ctx.project.id, task.description, notes)
    const pin = await this.#pinnedDesign(ctx.project.prefix, task.id)
    const previous = await this.#previousAuthorRun(db, task.id, ctx.agent.id, ctx.run.role, ctx.run.id)
    const [lastRun] = await db.select().from(runs)
      .where(and(eq(runs.taskId, task.id), inArray(runs.role, ['developer', 'designer']), ne(runs.id, ctx.run.id)))
      .orderBy(desc(runs.number)).limit(1)
    const stoppedRun = lastRun && (lastRun.state === 'interrupted' || (lastRun.state === 'failed' && lastRun.summary === null))
      ? { number: lastRun.number, reason: lastRun.error ?? 'Stopped', wipSha: lastRun.headSha }
      : null
    const promptTask = {
      ref,
      title: task.title,
      description: task.description,
      branch: spike ? null : task.branch,
      spike,
      design: author.design ?? null,
      pin,
      defaultBranch: baseBranch,
      reviewRounds: task.reviewRounds,
      rebaseOnly: task.rebaseOnly,
      approvedHeadSha: task.approvedHeadSha,
      reviewRoundCap: ctx.project.reviewRoundCap,
      criteria: criteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })),
      comments: notes,
      attachments: attached,
      stoppedRun
    }
    const prompt = author.prompt(promptTask, ctx.agent.name)
    // A revision continues the author's own session with
    // the feedback given since, when it runs where that session lives. The
    // full prompt is the fallback when the session can't be resumed, and the
    // prompt on another runner, which starts fresh from the pushed branch.
    const local = previous !== null && (previous.runnerId === null || previous.runnerId === ctx.run.runnerId)
    const resume = local ? previous.agentSessionId : null
    if (resume) {
      await this.#note(ctx.run.id, `Resuming the agent session of run #${previous!.number} on ${this.#runnerName(ctx.run.runnerId)}`)
    } else if (previous) {
      await this.#note(ctx.run.id, `Run #${previous.number} ran on ${this.#runnerName(previous.runnerId)}, which is offline: starting a fresh session on ${this.#runnerName(ctx.run.runnerId)}${spike ? '' : ` from the pushed branch ${task.branch}`}`)
    }
    const since = previous?.queuedAt ?? null
    const feedback = since ? notes.filter(c => c.createdAt > since) : []
    return {
      runId: ctx.run.id,
      runNumber: ctx.run.number,
      leaseEpoch: ctx.run.leaseEpoch!,
      role: ctx.run.role,
      runtime: ctx.agent.runtime,
      projectId: ctx.project.id,
      repository: ctx.project.repository,
      defaultBranch: ctx.project.defaultBranch,
      baseBranch,
      taskId: task.id,
      taskRef: ref,
      taskType: task.type,
      designPinned: pin !== null,
      branch: spike ? null : task.branch,
      headSha: spike ? null : task.headSha,
      continueFrom: stoppedRun?.wipSha ?? null,
      planSessionId: null,
      agentSessionId: resume,
      fallbackPrompt: resume ? prompt : null,
      model: null,
      timeoutSeconds: RUN_TIMEOUT_SECONDS,
      prompt: !resume ? prompt : author.revision(promptTask, feedback)
    } as RunJob
  }

  // The design version a build task is pinned to (D20), for its prompt
  async #pinnedDesign(prefix: string, taskId: string): Promise<PinnedDesign | null> {
    const [pin] = await this.#d.db.select({ screens: taskDesignPins.screens, version: designVersions.version, branch: designVersions.branch, commitSha: designVersions.commitSha, number: tasks.number })
      .from(taskDesignPins).innerJoin(designVersions, eq(designVersions.id, taskDesignPins.designVersionId)).innerJoin(tasks, eq(tasks.id, designVersions.taskId))
      .where(eq(taskDesignPins.taskId, taskId))
    return pin ? { designRef: taskRef(prefix, pin.number), version: pin.version, screens: pin.screens, branch: pin.branch, commitSha: pin.commitSha } : null
  }

  // This agent's last run in the same authoring role on the task that started a session: its
  // runner holds the worktree and session a revision resumes
  async #previousAuthorRun(db: Executor, taskId: string, agentId: string, role: AgentRow['role'], exclude?: string) {
    // A developer-authored design is a session boundary (D23), including
    // when this agent had an older designer session before that developer run.
    const [legacy] = role === 'designer'
      ? await db.select({ number: runs.number }).from(runs)
          .where(and(eq(runs.taskId, taskId), eq(runs.role, 'developer')))
          .orderBy(desc(runs.number)).limit(1)
      : []
    const [previous] = await db.select({ number: runs.number, runnerId: runs.runnerId, agentSessionId: runs.agentSessionId, queuedAt: runs.queuedAt }).from(runs)
      .where(and(eq(runs.taskId, taskId), eq(runs.role, role), eq(runs.agentId, agentId), legacy ? gt(runs.number, legacy.number) : undefined, exclude ? ne(runs.id, exclude) : undefined, isNotNull(runs.agentSessionId)))
      .orderBy(desc(runs.number)).limit(1)
    return previous ?? null
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
    // A spike has no commit: the reviewer gets a checkout of the default
    // branch and judges the findings the developer last reported (D19)
    const baseBranch = await taskBase(db, task, ctx.project)
    const spike = task.type === 'spike'
    const [reported] = spike
      ? await db.select({ summary: runs.summary }).from(runs)
          .where(and(eq(runs.taskId, task.id), eq(runs.outcome, 'findings_reported'))).orderBy(desc(runs.number)).limit(1)
      : []
    // A design: the reviewer checks the version submitted at this commit (D20)
    const design = task.type === 'design'
    const [version] = design && task.headSha
      ? await db.select().from(designVersions)
          .where(and(eq(designVersions.taskId, task.id), eq(designVersions.commitSha, task.headSha))).orderBy(desc(designVersions.version)).limit(1)
      : []
    const pin = await this.#pinnedDesign(ctx.project.prefix, task.id)
    return {
      runId: ctx.run.id,
      runNumber: ctx.run.number,
      leaseEpoch: ctx.run.leaseEpoch!,
      role: 'reviewer',
      runtime: ctx.agent.runtime,
      projectId: ctx.project.id,
      repository: ctx.project.repository,
      defaultBranch: ctx.project.defaultBranch,
      baseBranch,
      taskId: task.id,
      taskRef: ref,
      taskType: task.type,
      designPinned: pin !== null,
      branch: spike ? null : task.branch,
      headSha: spike ? null : task.headSha,
      planSessionId: null,
      agentSessionId: null,
      fallbackPrompt: null,
      model: null,
      timeoutSeconds: RUN_TIMEOUT_SECONDS,
      prompt: reviewerPrompt({
        ref,
        title: task.title,
        description: task.description,
        branch: spike ? null : task.branch,
        spike,
        findings: reported?.summary ?? null,
        design: design ? { version: version?.version ?? null } : null,
        pin,
        underReview: version ? { version: version.version, commitSha: version.commitSha, screenshots: version.screenshots.map(s => s.fileName) } : null,
        defaultBranch: baseBranch,
        rebaseOnly: task.rebaseOnly,
        approvedHeadSha: task.approvedHeadSha,
        reviewRounds: task.reviewRounds,
        reviewRoundCap: ctx.project.reviewRoundCap,
        criteria: criteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })),
        comments: notes,
        attachments: attached,
        headSha: task.headSha!,
        prUrl: task.prUrl,
        evidence: items.map(e => ({ id: e.id, criterionId: e.criterionId, kind: e.kind, note: e.note, fileName: e.fileName })),
        requiredChecks: ctx.project.requiredChecks,
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
    const expiredEpics = await this.#d.db.select().from(runs).where(and(isNotNull(runs.epicId), inArray(runs.state, [...ACTIVE_RUN_STATES]), lt(runs.leaseExpiresAt, this.#now())))
    for (const run of expiredEpics) {
      const ctx = await this.#load(run.id)
      if (ctx) {
        await this.#endRun(ctx, { state: 'interrupted', error: 'Epic review lease expired' })
        this.#d.runner.send({ type: 'run.stop', runId: run.id, reason: 'Lease expired' }, run.runnerId)
      }
    }
    const expired = await this.#d.db.select({ runId: tasks.leaseRunId }).from(tasks)
      .where(and(isNotNull(tasks.leaseRunId), lt(tasks.leaseExpiresAt, this.#now())))
    for (const { runId } of expired) {
      const ctx = runId ? await this.#load(runId) : null
      if (!ctx) continue
      await this.#endRun(ctx, { state: 'interrupted', error: 'Lease expired: no heartbeat from the runner' })
      this.#d.runner.send({ type: 'run.stop', runId: ctx.run.id, reason: 'Lease expired' }, ctx.run.runnerId)
      await this.#publish(ctx)
    }
  }

  async onConnected(activeRuns: { runId: string, leaseEpoch: number }[], runnerId: string): Promise<void> {
    const { db, runner } = this.#d
    // Runs the server thinks are live but the runner doesn't have were lost
    // when the runner restarted
    const live = await db.select().from(runs).where(and(eq(runs.runnerId, runnerId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    for (const run of live) {
      // A PM turn waiting for a slot was never sent
      if (run.pmJob !== null) continue
      if (activeRuns.some(a => a.runId === run.id && a.leaseEpoch === run.leaseEpoch)) continue
      const ctx = await this.#load(run.id)
      if (!ctx) continue
      await this.#endRun(ctx, { state: 'interrupted', error: 'The runner restarted during the run: it shut down before it could report' })
      await this.#publish(ctx)
    }
    await this.refreshLoad()
    // Runs the runner has but the server no longer recognises must stop
    for (const active of activeRuns) {
      const ctx = await this.#fenced(active.runId, active.leaseEpoch)
      if (!ctx || ctx.run.runnerId !== runnerId) {
        if (await this.#savingWork(active.runId, active.leaseEpoch, runnerId)) continue
        runner.send({ type: 'run.stop', runId: active.runId, reason: 'The server no longer recognises this run' }, runnerId)
      }
    }
  }

  onReady(): void {
    this.poke()
    void this.releaseNotes?.sweep()
    void this.sweep.run()
  }

  async onHeartbeat(activeRuns: { runId: string, leaseEpoch: number }[], runnerId: string, sentAt?: number): Promise<void> {
    const now = this.#now()
    for (const active of activeRuns) {
      const ctx = await this.#fenced(active.runId, active.leaseEpoch)
      if (!ctx || ctx.run.runnerId !== runnerId || (ctx.task?.leaseExpiresAt && ctx.task.leaseExpiresAt <= now)) {
        if (await this.#savingWork(active.runId, active.leaseEpoch, runnerId)) continue
        this.#d.runner.send({ type: 'run.stop', runId: active.runId, reason: 'This run no longer holds its lease' }, runnerId)
        continue
      }
      if (ctx.run.epicId) await this.#d.db.update(runs).set({ leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS) }).where(eq(runs.id, ctx.run.id))
      if (ctx.task) {
        await this.#d.db.update(tasks).set({
          leaseHeartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + 15 * 60 * 1000)
        }).where(and(eq(tasks.id, ctx.task.id), eq(tasks.leaseRunId, ctx.run.id), eq(tasks.leaseEpoch, active.leaseEpoch)))
      }
      this.#confirmLease(ctx, sentAt)
    }
  }

  // A human stop or the kill switch ends the run here at once, but the runner
  // lists it until the agent has exited. It was told to keep its work, so a
  // keepWork-less stop would wrongly revoke the push, unless the task moved on.
  // A lost lease also leaves a run interrupted: only these two stops count.
  async #savingWork(runId: string, leaseEpoch: number, runnerId: string): Promise<boolean> {
    const ctx = await this.#load(runId)
    if (!ctx?.task || ctx.task.deletedAt || ctx.task.leaseRunId !== null) return false
    const { run } = ctx
    return (run.role === 'developer' || run.role === 'designer') && run.state === 'interrupted' && run.leaseEpoch === leaseEpoch && run.runnerId === runnerId && KEEP_WORK_STOPS.has(run.error ?? '')
  }

  #confirmLease(ctx: RunContext, sentAt: number | undefined): void {
    // Echo the runner's clock: delayed replies after sleep must already be expired,
    // and runner/server wall clocks need not agree. Older runners need no ack.
    if ((ctx.run.role !== 'developer' && ctx.run.role !== 'designer') || sentAt === undefined || !Number.isFinite(sentAt)) return
    this.#d.runner.send({ type: 'run.lease', runId: ctx.run.id, leaseEpoch: ctx.run.leaseEpoch!, validUntil: new Date(sentAt + 2 * RUNNER_HEARTBEAT_MS).toISOString() }, ctx.run.runnerId)
  }

  async onDisconnected(): Promise<void> {
    // Nothing yet: leases expire on their own if the runner doesn't come back
  }

  // ── Run lifecycle ──────────────────────────────────────────────────────────

  async onRunMessage(message: Extract<RunnerMessage, { type: 'run.started' | 'run.events' | 'run.ended' }>, runnerId: string): Promise<void> {
    const { db, events, transcripts } = this.#d
    const owner = await this.#load(message.runId)
    if (!owner || owner.run.runnerId !== runnerId) return
    if (message.type === 'run.events') {
      // Transcript lines are kept even from a stale run: they're history, not writes
      await transcripts.append(message.runId, message.events)
      events.publish({ type: 'run.events', runId: message.runId, events: message.events })
      const usage = message.events.filter((e): e is Extract<RunEvent, { type: 'usage' }> => e.type === 'usage').at(-1)
      if (usage) {
        await db.update(runs).set({ inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens, outputTokens: usage.outputTokens }).where(eq(runs.id, message.runId))
      }
      return
    }

    if (message.type === 'run.started') {
      const ctx = await this.#fenced(message.runId, message.leaseEpoch)
      if (!ctx) return
      // Still active: the server may have ended the run since it was fenced
      await db.update(runs).set({ state: 'running', startedAt: this.#now(), agentSessionId: message.agentSessionId })
        .where(and(eq(runs.id, ctx.run.id), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      this.#confirmLease(ctx, message.sentAt)
      if (ctx.run.role === 'pm' && ctx.run.planSessionId) await this.plans?.onRunStarted(ctx.run.planSessionId, message.agentSessionId)
      await this.#publish(ctx)
      return
    }

    // run.ended
    const ctx = await this.#load(message.runId)
    if (!ctx) return
    const live = (ACTIVE_RUN_STATES as readonly RunState[]).includes(ctx.run.state) && ctx.run.leaseEpoch === message.leaseEpoch
    if (live && ctx.run.role === 'pm') await this.#pmExited(ctx, message.exit, message.lastActivityAt)
    else if (live) await this.#runExited(ctx, message.exit, message.lastActivityAt, message.wipSha ?? null)
    // The server already ended a run it stopped; only the runner knows the agent's last activity
    else if (ctx.run.state === 'interrupted' && ctx.run.error && ctx.run.leaseEpoch === message.leaseEpoch) {
      await db.update(runs).set({ error: withLastActivity(ctx.run.error, message.lastActivityAt) }).where(eq(runs.id, ctx.run.id))
    }
    // The commit that saved a stopped run's work, for the retry's prompt
    if (!live && message.wipSha && ctx.run.leaseEpoch === message.leaseEpoch) {
      await db.update(runs).set({ headSha: message.wipSha }).where(eq(runs.id, ctx.run.id))
    }
    const blob = await transcripts.finish(ctx.run.id)
    if (blob) await db.update(runs).set({ transcriptBlob: blob }).where(eq(runs.id, ctx.run.id))
    // Kept whether or not the run is live: an accepted outcome already ended it
    if (message.timings) await db.update(runs).set({ timings: message.timings }).where(eq(runs.id, ctx.run.id))
    await this.#publish(ctx)
    this.poke()
  }

  // A PM turn has no outcome to report: its reply is the last thing it said
  async #pmExited(ctx: RunContext, exit: RunExit, lastActivityAt: string | null | undefined): Promise<void> {
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
      case 'signalled':
        if ((exit.kind === 'exited' && exit.code === 0) || reply) {
          await this.#endRun(ctx, { state: 'completed', summary: reply })
        } else {
          error = exit.kind === 'exited' ? `The PM exited with code ${exit.code}` : runExitError(exit, lastActivityAt)
          await this.#endRun(ctx, { state: 'failed', outcome: 'failed', error })
        }
        break
      case 'stopped':
      case 'runner_shutdown':
        await this.#endRun(ctx, { state: 'interrupted', error: runExitError(exit, lastActivityAt) })
        error = 'The turn was stopped'
        break
      case 'timed_out':
        await this.#endRun(ctx, { state: 'failed', outcome: 'failed', error: runExitError(exit, lastActivityAt) })
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
  async #runExited(ctx: RunContext, exit: RunExit, lastActivityAt: string | null | undefined, headSha: string | null): Promise<void> {
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
      case 'runner_shutdown':
        await this.#endRun(ctx, { state: 'interrupted', error: runExitError(exit, lastActivityAt), headSha })
        return
      default:
        await this.#failRun(ctx, runExitError(exit, lastActivityAt), { headSha })
    }
  }

  // A failed run counts towards the failed-run cap (D10); at the cap the task fails
  async #failRun(ctx: RunContext, error: string, fields: Partial<typeof runs.$inferInsert> = {}, note?: string): Promise<void> {
    const comment = await this.#d.db.transaction(async (tx) => {
      const comment = note && ctx.task ? await this.#postNote(tx, ctx, note) : null
      if (ctx.task) {
        const { task, project } = await lockTask(tx, ctx.task.id)
        if (task.leaseRunId === ctx.run.id && ['in_progress', 'agent_review'].includes(task.status)) {
          await applyTransition(tx, task, project, { type: 'run_failed' }, server, { event: 'run_failed', runId: ctx.run.id, error })
        }
      }
      await this.#endRunIn(tx, ctx, { ...fields, state: 'failed', outcome: 'failed', error })
      return comment
    })
    if (comment) this.#d.events.publish({ type: 'comment.created', comment })
  }

  // The developer's work note: what this run did, as a comment by its agent,
  // so the task's history shows the developer's turns between reviews
  async #postNote(tx: Executor, ctx: RunContext, note: string): Promise<Comment> {
    return addComment(tx, ctx.task!.id, { body: note, pinned: false }, this.#actor(ctx))
  }

  async #endRun(ctx: RunContext, end: RunEnd): Promise<void> {
    await this.#d.db.transaction(tx => this.#endRunIn(tx, ctx, end))
  }

  // Ends the run and releases its lease, if it still holds one
  async #endRunIn(tx: Executor, ctx: RunContext, end: RunEnd): Promise<void> {
    await tx.update(runs).set(runEndValues(end, this.#now())).where(eq(runs.id, ctx.run.id))
    if (ctx.task) {
      await tx.update(tasks).set({ leaseRunId: null, leaseRole: null, leaseExpiresAt: null, leaseHeartbeatAt: null, updatedAt: this.#now() })
        .where(and(eq(tasks.id, ctx.task.id), eq(tasks.leaseRunId, ctx.run.id)))
    }
    await appendAudit(tx, { projectId: ctx.project.id, taskId: ctx.task?.id ?? null, actor: server }, auditEvent('run.ended', { runId: ctx.run.id, runNumber: ctx.run.number, state: end.state, outcome: end.outcome ?? null, error: 'error' in end ? end.error : null }))
  }

  // A human stops a run: the process tree is killed, the run is Interrupted
  // and the task is paused so the scheduler doesn't restart it (flows.md §3)
  async stopRun(runId: string, actor: Actor): Promise<void> {
    const ctx = await this.#load(runId)
    if (!ctx || !(ACTIVE_RUN_STATES as readonly RunState[]).includes(ctx.run.state)) throw new ApiFailure(409, { code: 'conflict', constraint: 'run_not_active' })
    this.#d.runner.send({ type: 'run.stop', runId, reason: 'Stopped by a human', keepWork: true }, ctx.run.runnerId)
    await this.#d.db.transaction(async (tx) => {
      await this.#endRunIn(tx, ctx, { state: 'interrupted', error: HUMAN_STOP })
      if (ctx.task) await tx.update(tasks).set({ paused: true }).where(eq(tasks.id, ctx.task.id))
      await appendAudit(tx, { projectId: ctx.project.id, taskId: ctx.task?.id ?? null, actor }, auditEvent('run.stopped', { runId }))
    })
    await this.#publish(ctx)
  }

  // A human lets a paused task be claimed again (flows.md §3). Only clears the
  // flag: the caller pokes the scheduler once the task is published. Throws
  // 409 task_not_paused, so a double click can't resume it twice.
  async resumeTask(taskId: string, actor: Actor): Promise<void> {
    if (actor.kind !== 'human') throw new ApiFailure(403, { code: 'forbidden' })
    await this.#d.db.transaction(async (tx) => {
      const [task] = await tx.update(tasks).set({ paused: false, updatedAt: this.#now() })
        .where(and(eq(tasks.id, taskId), eq(tasks.paused, true), isNull(tasks.deletedAt)))
        .returning({ projectId: tasks.projectId })
      if (!task) throw new ApiFailure(409, { code: 'conflict', constraint: 'task_not_paused' })
      await appendAudit(tx, { projectId: task.projectId, taskId, actor }, auditEvent('task.resumed', {}))
    })
  }

  // A human messages a live developer, designer or reviewer run. It's kept as their
  // comment on the task, with an audit entry, and sent to the runner as
  // run.message. The runner may still turn it down (e.g. a Codex run); it
  // says so in the run's transcript. Throws 409 run_not_live when no runner
  // holds the run.
  async messageRun(projectId: string, runId: string, input: { text: string, attachments: string[] }, actor: Actor): Promise<{ runId: string, comment: Comment }> {
    const { db, events, runner } = this.#d
    const ctx = await this.#load(runId)
    if (!ctx || ctx.run.projectId !== projectId) throw new ApiFailure(404, { code: 'not_found' })
    const notLive = (reason: string) => new ApiFailure(409, { code: 'run_not_live', reason })
    const { run, task } = ctx
    if (!task || (run.role !== 'developer' && run.role !== 'designer' && run.role !== 'reviewer')) throw notLive(`Run #${run.number} is a ${run.role} run; only developer, designer and reviewer runs take messages`)
    if (run.state === 'queued') throw notLive(`Run #${run.number} hasn't started yet`)
    if (!(ACTIVE_RUN_STATES as readonly RunState[]).includes(run.state) || run.state === 'stopping') throw notLive(`Run #${run.number} has ended`)
    if (task.leaseRunId !== run.id || task.leaseEpoch !== run.leaseEpoch) throw notLive(`Run #${run.number} no longer holds ${taskRef(ctx.project.prefix, task.number)}`)
    if (!runner.isOnline(run.runnerId)) throw notLive('No runner is connected to deliver the message')

    const found = input.attachments.length === 0
      ? []
      : await db.select({ id: attachments.id, fileName: attachments.fileName }).from(attachments)
          .where(and(eq(attachments.projectId, projectId), inArray(attachments.id, input.attachments)))
    const missing = input.attachments.filter(id => !found.some(a => a.id === id))
    if (missing.length > 0) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['attachments'], message: `Not an attachment in this project: ${missing.join(', ')}` }] })
    // The same references as images in a comment, so get_task lists them and
    // the agent can read each with get_attachment
    const images = input.attachments.map(id => `![${found.find(a => a.id === id)!.fileName.replace(/[[\]]/g, '')}](attachment:${id})`)
    const body = [input.text, ...images].join('\n\n')

    const comment = await db.transaction(async (tx) => {
      const comment = await addComment(tx, task.id, { body, pinned: false }, actor)
      await appendAudit(tx, { projectId, taskId: task.id, actor }, auditEvent('run.message_sent', { runId: run.id, runNumber: run.number, commentId: comment.id, attachments: input.attachments }))
      // Sent last, so a runner that dropped off rolls the comment back
      if (!runner.send({ type: 'run.message', runId: run.id, leaseEpoch: run.leaseEpoch!, text: body }, run.runnerId)) {
        throw notLive('No runner is connected to deliver the message')
      }
      return comment
    })
    events.publish({ type: 'comment.created', comment })
    return { runId: run.id, comment }
  }

  // PRD §7.3: a human edited the description or criteria of a task a
  // developer, designer or reviewer run holds. A run that takes messages is told at
  // once; otherwise (Codex, not started yet, no runner) a pinned comment
  // carries the change to the agent through get_task and to the next run.
  async noticeTaskEdit(taskId: string, edit: TaskContentEdit, actor: Actor): Promise<void> {
    const { db, events } = this.#d
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    if (!task?.leaseRunId) return
    const ctx = await this.#load(task.leaseRunId)
    if (!ctx || ctx.run.leaseEpoch !== task.leaseEpoch) return
    const { run, project } = ctx
    if (run.role !== 'developer' && run.role !== 'designer' && run.role !== 'reviewer') return
    if (!(ACTIVE_RUN_STATES as readonly RunState[]).includes(run.state) || run.state === 'stopping') return

    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId)).orderBy(asc(acceptanceCriteria.position))
    const ref = taskRef(project.prefix, task.number)
    const what = [edit.description && 'description', edit.criteria && 'acceptance criteria'].filter(Boolean).join(' and ')
    const counts = edit.criteria
      ? [edit.criteria.added && `${edit.criteria.added} added`, edit.criteria.removed && `${edit.criteria.removed} removed`, edit.criteria.reworded && `${edit.criteria.reworded} reworded`].filter(Boolean).join(', ') || 'reordered'
      : null
    const body = (lead: string) => [
      lead,
      edit.description ? `**Description**\n\n${richTextToMarkdown(task.description) || '(no description)'}` : null,
      edit.criteria ? `**Acceptance criteria** (${counts})\n\n${criteria.map(c => `- [${c.id}] ${c.text}${c.checkedByHuman ? ' — checked by a human: skip evidence and verdict; do not request changes over it' : ''}`).join('\n') || '(none)'}` : null
    ].filter(Boolean).join('\n\n')

    if ((RUNTIMES_TAKING_MESSAGES as readonly string[]).includes(ctx.agent.runtime) && run.state !== 'queued') {
      try {
        await this.messageRun(project.id, run.id, { text: body(`The ${what} of ${ref} changed while you were working on it. Work to the new text below; evidence and verdicts go against these criterion IDs.`), attachments: [] }, actor)
        return
      } catch (error) {
        if (!(error instanceof ApiFailure) || error.status !== 409) throw error
      }
    }
    const comment = await db.transaction(async (tx) => {
      const comment = await addComment(tx, taskId, { body: body(`The ${what} of ${ref} changed during run #${run.number}, which couldn't be told while it ran. Work to the new text below.`), pinned: true }, actor)
      await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.edit_pinned', { runId: run.id, runNumber: run.number, commentId: comment.id }))
      return comment
    })
    events.publish({ type: 'comment.created', comment })
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
        runner.send({ type: 'run.stop', runId: ctx.run.id, reason: 'The task was deleted' }, ctx.run.runnerId)
        await this.#endRun(ctx, { state: 'interrupted', error: 'The task was deleted' })
        this.#d.events.publish({ type: 'run.updated', run: await getRun(db, ctx.run.id) })
        await this.refreshLoad()
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
      runner.send({ type: 'run.stop', runId: id, reason: 'The project was removed' }, ctx.run.runnerId)
      await this.#endRun(ctx, { state: 'interrupted', error: 'The project was removed' })
      this.#d.events.publish({ type: 'run.updated', run: await getRun(db, id) })
    }
    await this.refreshLoad()
    const worked = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, projectId), ne(tasks.status, 'backlog')))
    const project = await db.transaction(async (tx) => {
      // Tasks, epics, plans, plan sessions and runs go with it (onDelete: cascade)
      const [row] = await tx.delete(projects).where(eq(projects.id, projectId)).returning()
      if (!row) throw new ApiFailure(404, { code: 'not_found' })
      // Not tied to the project, or it would go too
      await appendAudit(tx, { projectId: null, actor }, auditEvent('project.deleted', { projectId, name: row.name, repository: row.repository }))
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

  async onToolCall(message: Extract<RunnerMessage, { type: 'tool.call' }>, runnerId: string): Promise<unknown> {
    const ctx = await this.#fenced(message.runId, message.leaseEpoch)
    if (!ctx || ctx.run.runnerId !== runnerId) throw new ToolError('This run no longer holds its task: its lease expired or was given to another run. Stop working.')
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
      developer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'get_design', 'report_outcome'],
      designer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'get_design', 'submit_design', 'report_outcome'],
      reviewer: ['get_task', 'add_comment', 'get_evidence', 'get_attachment', 'get_design', 'report_outcome'],
      pm: ['list_tasks', 'get_task', 'get_run_outcomes', 'get_attachment', 'get_design', 'ask_question', 'propose_plan', 'approve_plan', 'flag_stale_docs']
    }
    if (!allowed[role]?.includes(tool)) throw new ToolError(`The ${role} can’t use ${tool}`)
    if (tool === 'get_attachment') return this.#getAttachment(ctx, z.object({ attachmentId: z.string() }).parse(input))
    if (tool === 'get_design') {
      const { taskRef: ref, version } = z.object({ taskRef: z.string(), version: z.number().int().positive().optional() }).parse(input)
      return readDesign(this.#d.db, this.#d.blobs, ctx.project, ref, version).catch((error: unknown) => {
        throw error instanceof DesignNotFound ? new ToolError(error.message) : error
      })
    }
    if (role === 'pm') {
      if (!this.plans || !ctx.run.planSessionId) throw new ToolError('Planning is unavailable')
      return this.plans.tool(ctx.run.planSessionId, ctx.run.id, tool, input, this.#actor(ctx))
    }

    if (ctx.run.epicId) {
      if (tool === 'get_task') {
        const [epic] = await this.#d.db.select().from(schema.epics).where(eq(schema.epics.id, ctx.run.epicId))
        if (!epic) throw new ToolError('Epic no longer exists')
        return epicReviewContext(this.#d.db, epic, ctx.project)
      }
      if (tool === 'get_evidence') return this.#getEvidence(ctx, z.object({ evidenceId: z.string().optional() }).parse(input))
      if (tool === 'report_outcome') {
        await this.epicPrs.report(ctx.run, parseReport(epicReviewReportSchema, input))
        this.#finished(ctx, 'Epic integration review recorded')
        return { ok: true }
      }
      throw new ToolError('Epic integration reviews use get_task, get_evidence and report_outcome')
    }
    switch (tool) {
      case 'get_task':
        return this.#getTask(ctx)
      case 'add_comment': {
        const { body } = z.object({ body: z.string().trim().min(1) }).parse(input)
        await this.#d.db.insert(comments).values({ taskId: ctx.task!.id, author: this.#actor(ctx), body })
        return { ok: true }
      }
      case 'attach_evidence': {
        const parsed = evidenceSchema.safeParse(input)
        if (!parsed.success) throw new ToolError(`Not attached. ${parsed.error.issues.map(i => i.message).join('. ')}.`)
        return this.#attachEvidence(ctx, parsed.data)
      }
      case 'get_evidence':
        return this.#getEvidence(ctx, z.object({ evidenceId: z.string().optional() }).parse(input))
      case 'submit_design':
        return this.#submitDesign(ctx, input)
      case 'report_outcome':
        // Human checks take no verdict, so a task with only those has none to give
        if (ctx.task && !ctx.task.rebaseOnly && await this.#onlyHumanChecks(ctx.task.id)) return this.#reportOutcome(ctx, parseReport(outcomeReportSchema, { criteria: [], ...(input as object) }))
        return this.#reportOutcome(ctx, ctx.task?.rebaseOnly ? parseReport(rebaseReviewReportSchema, input) : parseReport(outcomeReportSchema, input))
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
      criteria: criteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })),
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
    const row = { taskId: task.id, criterionId: input.criterionId, runId: ctx.run.id, round: task.reviewRounds, kind: input.kind }
    if (input.dataBase64 === undefined) {
      // A note: no blob, the text is the evidence
      const [note] = await this.#d.db.insert(evidence).values({ ...row, note: input.note.trim(), size: 0 }).returning()
      return { id: note!.id }
    }
    const data = Buffer.from(input.dataBase64, 'base64')
    if (data.length > MAX_EVIDENCE_BYTES) throw new ToolError('Evidence files are limited to 25 MB')
    const blob = await this.#d.blobs.put(data)
    const [file] = await this.#d.db.insert(evidence).values({
      ...row,
      note: input.note,
      blob,
      fileName: input.fileName!,
      contentType: input.contentType!,
      size: data.length
    }).returning()
    return { id: file!.id, sha256: blob }
  }

  // Evidence for the reviewer: a listing, or one item with its content.
  // Images come back as MCP image content so the reviewer can look at them.
  async #getEvidence(ctx: RunContext, input: { evidenceId?: string | undefined }) {
    const task = ctx.task
    const board = ctx.run.epicId ? await this.#d.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, ctx.run.epicId), isNull(tasks.deletedAt))) : []
    const items = task ? await listEvidence(this.#d.db, task.id) : (await Promise.all(board.map(t => listEvidence(this.#d.db, t.id)))).flat()
    if (!input.evidenceId) {
      return {
        round: task?.reviewRounds ?? 0,
        evidence: items.map(e => ({ id: e.id, criterionId: e.criterionId, kind: e.kind, note: e.note, fileName: e.fileName, contentType: e.contentType, size: e.size, round: e.round }))
      }
    }
    const item = items.find(e => e.id === input.evidenceId)
    if (!item) throw new ToolError(`${input.evidenceId} isn't evidence on this task`)
    const meta = { id: item.id, criterionId: item.criterionId, kind: item.kind, note: item.note, fileName: item.fileName, contentType: item.contentType, size: item.size }
    // A note is all text, already in the listing
    if (!item.contentType) return { ...meta, text: item.note }
    const [row] = await this.#d.db.select({ blob: evidence.blob }).from(evidence).where(eq(evidence.id, item.id))
    const data = row?.blob ? await this.#d.blobs.get(row.blob) : null
    if (!data) throw new ToolError('The file for this evidence is missing')
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

  async #onlyHumanChecks(taskId: string): Promise<boolean> {
    const rows = await this.#d.db.select({ checkedByHuman: acceptanceCriteria.checkedByHuman }).from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId))
    return rows.length > 0 && rows.every(c => c.checkedByHuman)
  }

  async #reportOutcome(ctx: RunContext, report: OutcomeReport): Promise<unknown> {
    if (ctx.run.role === 'reviewer') {
      switch (report.outcome) {
        case 'approved':
        case 'changes_requested':
          return this.#review(ctx, report, report.outcome)
        case 'blocked':
          if (!ctx.task?.rebaseOnly) throw new ToolError('Only a rebase review can report blocked.')
          return this.#blockedRebaseReview(ctx, report.summary)
        case 'failed':
          await this.#failRun(ctx, report.summary, { summary: report.summary })
          this.#finished(ctx, 'Reported failed')
          return { ok: true, message: 'Recorded. You can stop now.' }
      }
      throw new ToolError('A reviewer reports approved, changes_requested, blocked (rebase review only) or failed')
    }
    if (ctx.run.role === 'developer' || ctx.run.role === 'designer') {
      const problem = noteProblem(report.note)
      if (problem) throw new ToolError(`Not reported. ${problem} Add \`note\`: one line of at most ${MAX_NOTE_LENGTH} characters saying what this run did, e.g. "${NOTE_EXAMPLE}". Then report again.`)
      const spike = ctx.task!.type === 'spike'
      const design = ctx.task!.type === 'design'
      switch (report.outcome) {
        case 'pr_opened':
        case 'pr_updated':
        case 'pr_rebased':
          if (ctx.task!.rebaseOnly && report.outcome !== 'pr_rebased') throw new ToolError('Not submitted. A rebase-only round expects pr_rebased.')
          if (!ctx.task!.rebaseOnly && report.outcome === 'pr_rebased') throw new ToolError('Not submitted. This round expects pr_opened or pr_updated, not pr_rebased.')
          if (spike) throw new ToolError('Not submitted. A spike opens no PR: report your findings with outcome findings_reported.')
          if (design) throw new ToolError('Not submitted. A design task opens no PR: call submit_design, then report design_submitted.')
          return this.#submit(ctx, { ...report, outcome: report.outcome })
        case 'findings_reported':
          if (!spike) throw new ToolError(`Not submitted. Only a spike reports findings; this task reports ${design ? 'design_submitted' : 'pr_opened or pr_updated'}.`)
          return this.#reportFindings(ctx, report)
        case 'design_submitted':
          if (!design) throw new ToolError(`Not submitted. Only a design task reports design_submitted; this task reports ${spike ? 'findings_reported' : 'pr_opened or pr_updated'}.`)
          return this.#reportDesign(ctx, report)
        case 'stuck':
          return this.#stuck(ctx, report.summary, report.note!)
        case 'failed':
          await this.#failRun(ctx, report.summary, { summary: report.summary }, report.note)
          this.#finished(ctx, 'Reported failed')
          return { ok: true, message: 'Recorded. You can stop now.' }
      }
      throw new ToolError(spike
        ? 'A spike’s developer reports findings_reported, stuck or failed'
        : design ? 'A design task’s designer reports design_submitted, stuck or failed' : 'A developer reports pr_opened, pr_updated, pr_rebased (rebase-only rounds), stuck or failed')
    }
    throw new ToolError(`Outcomes for ${ctx.run.role} runs aren't supported yet`)
  }

  // flows.md steps 6–7: record the verdict for this commit. Changes
  // requested goes through core (round cap → Blocked) and the feedback is
  // posted as a comment; an approval moves the task to Human review or
  // Ready to merge, where the merge orchestrator takes over.
  async #review(ctx: RunContext, report: Extract<OutcomeReport, { outcome: ReviewVerdict }>, verdict: ReviewVerdict) {
    const { db } = this.#d
    const task = ctx.task!
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const [approval] = task.rebaseOnly && verdict === 'approved'
      ? await db.select().from(reviews).where(and(eq(reviews.taskId, task.id), eq(reviews.verdict, 'approved'), eq(reviews.headSha, task.approvedHeadSha!))).orderBy(desc(reviews.createdAt)).limit(1)
      : []
    if (task.rebaseOnly && verdict === 'approved' && !approval) throw new ToolError('Not recorded. No approval found for the previously approved head.')
    const verdicts = approval ? approval.criteria : report.criteria ?? []
    const missing = criteria.filter(c => !c.checkedByHuman && !verdicts.some(v => v.criterionId === c.id))
    if (missing.length > 0) {
      throw new ToolError(`Not recorded. Give a verdict for every criterion; missing: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}.`)
    }
    const unknown = verdicts.filter(v => !criteria.some(c => c.id === v.criterionId))
    if (unknown.length > 0) throw new ToolError(`Not recorded. Unknown criterion IDs: ${unknown.map(v => v.criterionId).join(', ')}.`)
    if (verdict === 'approved' && verdicts.some(v => !v.met && !criteria.find(c => c.id === v.criterionId)?.checkedByHuman)) {
      throw new ToolError('Not recorded. An approval needs every criterion met; otherwise report changes_requested.')
    }
    const kept = criteria.map(c => c.checkedByHuman
      ? { criterionId: c.id, met: null, note: 'Needs human check' }
      : { criterionId: c.id, met: verdicts.find(v => v.criterionId === c.id)!.met, note: verdicts.find(v => v.criterionId === c.id)!.note ?? '' })
    // An approval is a short note; the per-criterion notes are kept on the
    // review and shown next to the evidence. Changes requested spells out
    // every criterion for the developer, except the narrow rebase comment.
    const summary = approval ? `Approval carried over a reviewed rebase from ${task.approvedHeadSha} to ${task.headSha}. ${report.summary.trim()}` : report.summary
    const feedback = task.rebaseOnly ? `Rebase review ${verdict === 'approved' ? 'approved' : 'changes requested'}: ${report.summary.trim()}` : verdict === 'approved' ? `Approved: ${kept.some(v => v.met === null) ? humanCheckTally(kept.filter(v => v.met).length, kept.filter(v => v.met === null).length) : `all ${kept.length} criteria met`}. ${report.summary.trim()}`.trim() : feedbackComment(report.summary, kept, criteria)

    const next = await db.transaction(async (tx) => {
      const locked = await lockTask(tx, task.id)
      if (locked.task.leaseRunId !== ctx.run.id) throw new ToolError('This run lost its lease. Stop working.')
      const headSha = locked.task.headSha!
      // A change request is compared with the previous round's, if that
      // one requested changes too; near-identical feedback blocks the task
      const similarity = verdict === 'changes_requested' ? await this.#feedbackSimilarity(tx, task.id, locked.task.reviewRounds, report.summary, kept) : undefined
      await tx.insert(reviews).values({
        taskId: task.id, runId: ctx.run.id, round: locked.task.reviewRounds, headSha, verdict, summary, criteria: kept, author: this.#actor(ctx)
      })
      await tx.insert(comments).values({ taskId: task.id, author: this.#actor(ctx), body: feedback })
      await appendAudit(tx, { projectId: ctx.project.id, taskId: task.id, actor: this.#actor(ctx) }, auditEvent('review.recorded', { runId: ctx.run.id, verdict, headSha, round: locked.task.reviewRounds, met: kept.filter(v => v.met).length, of: kept.length, ...(similarity !== undefined && { similarity }) }))
      // Changes requested → the developer; approved → Human review when
      // flagged, otherwise Ready to merge (D10)
      const state = await applyTransition(tx, locked.task, locked.project, verdict === 'approved' ? { type: 'review_approved' } : { type: 'changes_requested', similarity }, server, { event: verdict === 'approved' ? 'review_approved' : 'changes_requested', runId: ctx.run.id, headSha, ...(similarity !== undefined && { similarity }) })
      await this.#endRunIn(tx, ctx, { state: 'completed', outcome: verdict, summary: report.summary, headSha })
      return state
    })
    this.#finished(ctx, `Review recorded: ${verdict}`, { handoff: true })
    const spike = task.type === 'spike'
    return {
      ok: true,
      message: verdict === 'changes_requested'
        ? next.status === 'blocked'
          ? `Changes requested. The task is Blocked for a human (${next.reason}). You can stop now.`
          : 'Changes requested; your feedback was sent to the developer. You can stop now.'
        : task.type === 'design'
          ? 'Approval recorded. The human reviews the design next. You can stop now.'
          : spike
            ? 'Approval recorded. A human reviews the findings next. You can stop now.'
            : 'Approval recorded. Corral handles human review, CI and the merge from here. You can stop now.'
    }
  }

  // How alike this change request is to the previous round's (0 to 1);
  // undefined when the previous round didn't request changes
  // (the first round, or the first since the task was unblocked)
  async #feedbackSimilarity(tx: Executor, taskId: string, round: number, summary: string, criteria: { met: boolean | null, note: string }[]): Promise<number | undefined> {
    if (round === 0) return undefined
    const [previous] = await tx.select({ summary: reviews.summary, criteria: reviews.criteria }).from(reviews)
      .where(and(eq(reviews.taskId, taskId), eq(reviews.round, round - 1), eq(reviews.verdict, 'changes_requested')))
      .orderBy(desc(reviews.createdAt)).limit(1)
    if (!previous) return undefined
    return feedbackSimilarity(reviewFeedbackText(previous.summary, previous.criteria), reviewFeedbackText(summary, criteria))
  }

  // D24: a changed binding decision must be settled by the human.
  async #blockedRebaseReview(ctx: RunContext, reason: string) {
    if (!reason.trim()) throw new ToolError('Explain the changed binding decision and affected criteria for the human.')
    await this.#d.db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, ctx.task!.id)
      if (task.leaseRunId !== ctx.run.id) throw new ToolError('This run lost its lease. Stop working.')
      await tx.insert(comments).values({ taskId: task.id, author: this.#actor(ctx), body: `Rebase review blocked: ${reason.trim()}` })
      await applyTransition(tx, task, project, { type: 'block', reason }, server, { event: 'blocked', runId: ctx.run.id })
      await this.#endRunIn(tx, ctx, { state: 'completed', outcome: 'blocked', summary: reason })
    })
    this.#finished(ctx, 'Rebase review blocked: waiting on a human')
    return { ok: true, message: 'The task is Blocked for a human decision. You can stop now.' }
  }

  // Asks a human: the task becomes Blocked with the question as its reason (D11)
  async #stuck(ctx: RunContext, question: string, note: string) {
    const comment = await this.#d.db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, ctx.task!.id)
      const comment = await this.#postNote(tx, ctx, note)
      await applyTransition(tx, task, project, { type: 'block', reason: question }, server, { event: 'stuck', runId: ctx.run.id })
      await this.#endRunIn(tx, ctx, { state: 'completed', outcome: 'stuck', summary: question })
      return comment
    })
    this.#d.events.publish({ type: 'comment.created', comment })
    this.#finished(ctx, 'Stuck: waiting on a human')
    return { ok: true, message: 'The task is Blocked until a human answers. You can stop now.' }
  }

  // flows.md step 5: validate the developer's submission, open or update the
  // PR, then move the task to Agent review
  async #submit(ctx: RunContext, report: OutcomeReport & { outcome: 'pr_opened' | 'pr_updated' | 'pr_rebased' }) {
    const { db, github } = this.#d
    const task = ctx.task!
    if (!report.headSha) throw new ToolError('There is no commit to submit. Commit your work, then report again.')

    const head = await github.branchHead(ctx.project.repository, task.branch!)
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const attached = await db.select({ criterionId: evidence.criterionId }).from(evidence)
      .where(and(eq(evidence.taskId, task.id), eq(evidence.round, task.reviewRounds)))
    const missing = criteria.filter(c => !c.checkedByHuman && !attached.some(e => e.criterionId === c.id))

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
    // A rebase task's commits are already on the epic PR; it has no PR of its own
    let pr: PullRequest | null = null
    if (!await isEpicRebaseTask(db, task)) {
      const existing = task.prNumber
        ? await github.getPullRequest(ctx.project.repository, task.prNumber)
        : await github.findOpenPullRequest(ctx.project.repository, task.branch!)
      pr = existing && existing.state === 'open' ? existing : null
      if (pr) await github.updatePullRequest(ctx.project.repository, pr.number, { body })
      else pr = await github.openPullRequest(ctx.project.repository, { head: task.branch!, base: await taskBase(db, task, ctx.project, github), title: `${ref}: ${task.title}`, body })
    }

    const comment = await db.transaction(async (tx) => {
      const locked = await lockTask(tx, task.id)
      if (locked.task.leaseRunId !== ctx.run.id) throw new ToolError('This run lost its lease while submitting. Stop working.')
      await applyTransition(tx, locked.task, locked.project, {
        type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
      }, server, { event: report.outcome, runId: ctx.run.id, headSha: report.headSha, pr: pr?.number ?? null })
      await tx.update(tasks).set({ headSha: report.headSha, ...(pr && { prNumber: pr.number, prUrl: pr.url }) }).where(eq(tasks.id, task.id))
      const comment = await this.#postNote(tx, ctx, report.note!)
      await this.#endRunIn(tx, ctx, { state: 'completed', outcome: report.outcome, summary: report.summary, headSha: report.headSha })
      return comment
    })
    this.#d.events.publish({ type: 'comment.created', comment })
    this.#finished(ctx, 'Outcome accepted', { handoff: true })
    if (!pr) return { ok: true, message: 'The rebased epic branch is ready for review. You can stop now.' }
    return { ok: true, pr: pr.url, message: `PR #${pr.number} is ready for review. You can stop now.` }
  }

  // D19: a spike's findings are its deliverable. Like a submission they
  // need evidence for every criterion, but nothing is pushed or opened on
  // GitHub: the findings go on the task as a comment and the reviewer judges
  // them. The submission is marked by this run, in place of a commit, so
  // each report gets its own review.
  async #reportFindings(ctx: RunContext, report: OutcomeReport) {
    const { db } = this.#d
    const task = ctx.task!
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const attached = await db.select({ criterionId: evidence.criterionId }).from(evidence)
      .where(and(eq(evidence.taskId, task.id), eq(evidence.round, task.reviewRounds)))
    const missing = criteria.filter(c => !c.checkedByHuman && !attached.some(e => e.criterionId === c.id))
    if (missing.length > 0) {
      throw new ToolError(`Not submitted. No evidence yet for: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}. Attach it and report again.`)
    }
    const marker = findingsMarker(ctx.run.id)
    const posted = await db.transaction(async (tx) => {
      const locked = await lockTask(tx, task.id)
      if (locked.task.leaseRunId !== ctx.run.id) throw new ToolError('This run lost its lease while submitting. Stop working.')
      await applyTransition(tx, locked.task, locked.project, {
        type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
      }, server, { event: 'findings_reported', runId: ctx.run.id, headSha: marker })
      await tx.update(tasks).set({ headSha: marker }).where(eq(tasks.id, task.id))
      const note = await this.#postNote(tx, ctx, report.note!)
      const findings = await addComment(tx, task.id, { body: `## Findings\n\n${report.summary.trim()}`, pinned: false }, this.#actor(ctx))
      await this.#endRunIn(tx, ctx, { state: 'completed', outcome: 'findings_reported', summary: report.summary })
      return [note, findings]
    })
    for (const comment of posted) this.#d.events.publish({ type: 'comment.created', comment })
    this.#finished(ctx, 'Findings accepted for review', { handoff: true })
    return { ok: true, message: 'Your findings are on the task and go to the reviewer next. You can stop now.' }
  }

  // D20: a new design version at the commit the runner just pushed. The
  // bundle must have index.html at its root so the preview can serve it.
  async #submitDesign(ctx: RunContext, input: unknown) {
    const { db, github, blobs } = this.#d
    const task = ctx.task!
    if (task.type !== 'design') throw new ToolError('Only a design task submits a design')
    const parsed = designSchema.safeParse(input)
    if (!parsed.success) throw new ToolError(`Not submitted. ${parsed.error.issues.map(i => i.message).join('; ')}.`)
    const submission = parsed.data
    const bundle = Buffer.from(submission.bundle.dataBase64, 'base64')
    const shots = submission.screenshots.map(s => ({ ...s, data: Buffer.from(s.dataBase64, 'base64') }))
    if (bundle.length + shots.reduce((n, s) => n + s.data.length, 0) > MAX_DESIGN_BYTES) throw new ToolError('Not submitted. A design version is limited to 25 MB.')
    if (!bundleHasRootIndex(bundle)) {
      throw new ToolError('Not submitted. The bundle has no index.html at its root. Pass the folder that holds index.html and its assets, with relative paths.')
    }
    const head = await github.branchHead(ctx.project.repository, task.branch!)
    if (head !== submission.headSha) throw new ToolError(`Not submitted. The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${submission.headSha}. Try again.`)

    const bundleBlob = await blobs.put(bundle)
    const specBlob = await blobs.put(Buffer.from(submission.spec))
    const screenshots: { blob: string, fileName: string, contentType: string }[] = []
    for (const shot of shots) screenshots.push({ blob: await blobs.put(shot.data), fileName: shot.fileName, contentType: shot.contentType })
    const version = await db.transaction(async (tx) => {
      const locked = await lockTask(tx, task.id)
      if (locked.task.leaseRunId !== ctx.run.id) throw new ToolError('This run lost its lease while submitting. Stop working.')
      const existing = await tx.select({ version: designVersions.version, status: designVersions.status }).from(designVersions).where(eq(designVersions.taskId, task.id))
      const [row] = await tx.insert(designVersions).values({
        taskId: task.id, version: nextDesignVersion(existing), bundleBlob, specBlob, screenshots, branch: task.branch!, commitSha: submission.headSha
      }).returning()
      await appendAudit(tx, { projectId: ctx.project.id, taskId: task.id, actor: this.#actor(ctx) }, auditEvent('design.submitted', { runId: ctx.run.id, version: row!.version, headSha: submission.headSha, screenshots: screenshots.length }))
      return row!
    })
    return {
      ok: true,
      version: version.version,
      commitSha: version.commitSha,
      message: `Design v${version.version} recorded at ${version.commitSha.slice(0, 10)}. Attach evidence for every criterion, then call report_outcome with outcome design_submitted.`
    }
  }

  // D20: the designer's outcome on a design task. Accepted only when a
  // version exists for the branch's current commit and every criterion has
  // evidence. Nothing is opened on GitHub.
  async #reportDesign(ctx: RunContext, report: OutcomeReport) {
    const { db, github } = this.#d
    const task = ctx.task!
    if (!report.headSha) throw new ToolError('There is no commit to submit. Commit your work, call submit_design, then report again.')
    const head = await github.branchHead(ctx.project.repository, task.branch!)
    const [version] = await db.select().from(designVersions)
      .where(and(eq(designVersions.taskId, task.id), eq(designVersions.commitSha, report.headSha))).orderBy(desc(designVersions.version)).limit(1)
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const attached = await db.select({ criterionId: evidence.criterionId }).from(evidence)
      .where(and(eq(evidence.taskId, task.id), eq(evidence.round, task.reviewRounds)))
    const missing = criteria.filter(c => !c.checkedByHuman && !attached.some(e => e.criterionId === c.id))
    const problems = [
      head !== report.headSha ? `The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${report.headSha}.` : '',
      !version ? `No design version was submitted at your latest commit ${report.headSha}: call submit_design first.` : '',
      missing.length > 0 ? `No evidence yet for: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}.` : ''
    ].filter(Boolean)
    if (problems.length > 0) throw new ToolError(`Not submitted. ${problems.join(' ')} Fix this and report again.`)

    const comment = await db.transaction(async (tx) => {
      const locked = await lockTask(tx, task.id)
      if (locked.task.leaseRunId !== ctx.run.id) throw new ToolError('This run lost its lease while submitting. Stop working.')
      await applyTransition(tx, locked.task, locked.project, {
        type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
      }, server, { event: 'design_submitted', runId: ctx.run.id, headSha: report.headSha, version: version!.version })
      await tx.update(tasks).set({ headSha: report.headSha }).where(eq(tasks.id, task.id))
      const comment = await this.#postNote(tx, ctx, report.note!)
      await this.#endRunIn(tx, ctx, { state: 'completed', outcome: 'design_submitted', summary: report.summary, headSha: report.headSha })
      return comment
    })
    this.#d.events.publish({ type: 'comment.created', comment })
    this.#finished(ctx, `Design v${version!.version} submitted for review`, { handoff: true })
    return { ok: true, message: `Design v${version!.version} goes to the reviewer next, then to the human. You can stop now.` }
  }

  #prBody(ref: string, title: string, summary: string, criteria: { id: string, text: string, checkedByHuman: boolean }[], attached: { criterionId: string | null }[]): string {
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
        return `| ${cell(c.text)} | ${c.checkedByHuman ? 'Needs human check' : `${n} item${n === 1 ? '' : 's'}`} |`
      }),
      '',
      `Screenshots, logs and the reviewer's verdicts are on the [evidence page](${link}?evidence=1).`,
      '',
      '---',
      '',
      `Corral task [${ref}: ${cell(title)}](${link})`
    ].join('\n')
  }

  // The outcome is recorded; the runner stops the agent's process tree. A
  // handoff (a pushed PR, a verdict) lets the next agent start the task now.
  #finished(ctx: RunContext, reason: string, { handoff = false } = {}): void {
    this.#d.runner.send({ type: 'run.stop', runId: ctx.run.id, reason }, ctx.run.runnerId)
    void this.#publish(ctx).then(() => this.poke(handoff && ctx.task ? [ctx.task.id] : []))
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

  // Slots in use on each runner, for the runner list (design/settings.md)
  async refreshLoad(): Promise<void> {
    const busy = await this.#d.db.select({ runnerId: runs.runnerId, n: count() }).from(runs)
      .where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), isNotNull(runs.runnerId)))
      .groupBy(runs.runnerId)
    this.#d.runner.setInUse(new Map(busy.map(b => [b.runnerId!, b.n])))
  }

  async #publish(ctx: RunContext): Promise<void> {
    const { db, events } = this.#d
    events.publish({ type: 'run.updated', run: await getRun(db, ctx.run.id) })
    await this.refreshLoad()
    // A soft-deleted task has nothing left to show
    const task = ctx.task ? await loadTask(db, ctx.task.id).catch(() => null) : null
    if (task) events.publish({ type: 'task.updated', task })
    if (task?.status === 'merged') this.poke(await publishDependents(db, events, task.id))
  }
}

// What stands in for a commit on a spike's submission: reviews are kept per
// submission, and a spike has no commits to tell them apart
export function findingsMarker(runId: string): string {
  return `findings-${runId}`
}

// Why a developer's work note is not acceptable, if it isn't
export function noteProblem(note: string | undefined): string | null {
  if (!note) return 'The work note is missing.'
  if (/[\r\n]/.test(note)) return 'The work note must be a single line.'
  if (note.length > MAX_NOTE_LENGTH) return `The work note is ${note.length} characters; the limit is ${MAX_NOTE_LENGTH}.`
  return null
}

// The review as a comment the developer reads next round
export function feedbackComment(summary: string, verdicts: { criterionId: string, met: boolean | null, note: string }[], criteria: { id: string, text: string }[]): string {
  const lines = verdicts.map((v) => {
    const text = criteria.find(c => c.id === v.criterionId)?.text ?? v.criterionId
    return `- ${v.met === null ? 'Needs human check:' : v.met ? '✅' : '❌'} ${text}${v.note ? ` — ${v.note}` : ''}`
  })
  return [summary.trim(), '', ...lines].join('\n').trim()
}

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'human': return 'Human'
    case 'agent': return actor.role === 'pm' ? 'PM' : actor.role === 'developer' ? 'Developer' : actor.role === 'designer' ? 'Designer' : 'Reviewer'
    case 'system': return 'Corral'
  }
}
