import { EVIDENCE_KINDS, type OutcomeReport, type RunEvent, type RunExit, type RunJob, type RunnerMessage } from '@corral/contracts'
import {
  ACTIVE_RUN_STATES,
  transition,
  taskRef,
  richTextToPlainText,
  type Actor,
  type RunOutcome,
  type RunState
} from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import { z } from 'zod'
import type { BlobStore } from './blob-store.ts'
import { claimNextTask, type Claim } from './claim.ts'
import { ApiFailure } from './errors.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import { slugify } from './projects.ts'
import { developerPrompt } from './prompts.ts'
import type { RunnerHandlers, RunnerHub } from './runner-hub.ts'
import { getRun, listAgents, listEvidence } from './runs.ts'
import { applyTransition, loadTask, lockTask, toTaskState, type ProjectRow, type TaskRow } from './tasks.ts'
import type { Transcripts } from './transcripts.ts'

const { acceptanceCriteria, agents, auditLog, comments, evidence, projects, runs, tasks } = schema

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

  constructor(deps: OrchestratorDeps) {
    this.#d = deps
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
    if (!runner.online) return
    const developers = await db.select().from(agents).where(eq(agents.role, 'developer')).orderBy(asc(agents.createdAt))
    for (const agent of developers) {
      for (let claim = await claimNextTask(db, agent.id, this.#now()); claim; claim = await claimNextTask(db, agent.id, this.#now())) {
        await this.#assign(claim)
      }
    }
  }

  async #assign(claim: Claim): Promise<void> {
    const ctx = await this.#load(claim.runId)
    if (!ctx?.task) return
    const job = await this.#developerJob(ctx)
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
    return {
      runId: ctx.run.id,
      runNumber: ctx.run.number,
      leaseEpoch: ctx.run.leaseEpoch!,
      role: 'developer',
      projectId: ctx.project.id,
      repository: ctx.project.repository,
      defaultBranch: ctx.project.defaultBranch,
      taskId: task.id,
      taskRef: ref,
      branch: task.branch,
      headSha: task.headSha,
      agentSessionId: null,
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
        comments: notes
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
      await this.#publish(ctx)
      return
    }

    // run.ended
    const ctx = await this.#load(message.runId)
    if (!ctx) return
    if ((ACTIVE_RUN_STATES as readonly RunState[]).includes(ctx.run.state) && ctx.run.leaseEpoch === message.leaseEpoch) {
      await this.#runExited(ctx, message.exit)
    }
    const blob = await transcripts.finish(ctx.run.id)
    if (blob) await db.update(runs).set({ transcriptBlob: blob }).where(eq(runs.id, ctx.run.id))
    await this.#publish(ctx)
    this.poke()
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
    await tx.update(runs).set({ endedAt: this.#now(), ...fields }).where(eq(runs.id, ctx.run.id))
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
      developer: ['get_task', 'add_comment', 'attach_evidence', 'report_outcome'],
      reviewer: ['get_task', 'add_comment', 'get_evidence', 'report_outcome'],
      pm: []
    }
    if (!allowed[role]?.includes(tool)) throw new ToolError(`The ${role} can't use ${tool}`)

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
    return {
      ref: taskRef(ctx.project.prefix, task.number),
      title: task.title,
      status: task.status,
      description: richTextToPlainText(task.description),
      branch: task.branch,
      reviewRound: task.reviewRounds,
      criteria: criteria.map(c => ({ id: c.id, text: c.text })),
      comments: (await this.#comments(task.id)).map(c => ({ ...c, createdAt: c.createdAt.toISOString() })),
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

  async #reportOutcome(ctx: RunContext, report: OutcomeReport & { outcome: string }): Promise<unknown> {
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
    return [
      summary,
      '',
      `**Corral task:** [${ref} ${title}](${link})`,
      '',
      '### Acceptance criteria',
      ...criteria.map((c) => {
        const n = attached.filter(e => e.criterionId === c.id).length
        return `- ${c.text} (${n} evidence item${n === 1 ? '' : 's'})`
      }),
      '',
      `Evidence: [open in Corral](${link}?evidence=1)`
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

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'human': return 'Human'
    case 'agent': return actor.role === 'pm' ? 'PM' : actor.role === 'developer' ? 'Developer' : 'Reviewer'
    case 'system': return 'Corral'
  }
}
