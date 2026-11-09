import type { CreateTaskInput, PlanSessionDetail, Project, PullRequestFile, RunEvent, RunJob, ServerEvent, Task } from '@corral/contracts'
import { markdownToRichText, type EpicReviewMode, type EvidenceKind } from '@corral/core'
import { databaseLocation, openDatabase, schema, type DatabaseHandle } from '@corral/db'
import { eq, sql } from 'drizzle-orm'
import { join } from 'node:path'
import { createApp } from '../app.ts'
import { boot, type Booted } from '../boot.ts'
import { EventBus } from '../events.ts'
import type { CheckResult } from '../github.ts'
import { answerSetupJob, FakeRunner, runStartHandled } from '../fake-runner.ts'
import { LONGEST_POLL_MS } from '../retries.ts'
import type { Services } from '../services.ts'
import { DemoGitHub, demoSha } from './demo-github.ts'

// Drives a real server, on a real data dir, through the same flows the tests
// use: a fake runner plays the agents and a fake GitHub holds the repos. Every
// state the demo shows is one the server reached itself.

interface DemoTaskInput extends Omit<Partial<CreateTaskInput>, 'description' | 'implementationPlan'> {
  title: string
  // Markdown
  description?: string
  implementationPlan?: string
}

const DURATION = /^(\d+(?:\.\d+)?)(m|h|d)$/
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

export class Seeder {
  readonly db: DatabaseHandle['db']
  readonly services: Services
  readonly github: DemoGitHub
  readonly runner: FakeRunner
  readonly #handle: DatabaseHandle
  readonly #booted: Booted
  readonly #events: EventBus
  readonly #app: ReturnType<typeof createApp>
  readonly #clock: { offsetMs: number }
  readonly #concurrency: { id: string, concurrency: number }[]
  #shiftSql: string[] = []

  private constructor(parts: { handle: DatabaseHandle, booted: Booted, events: EventBus, github: DemoGitHub, runner: FakeRunner, app: ReturnType<typeof createApp>, clock: { offsetMs: number }, concurrency: { id: string, concurrency: number }[] }) {
    this.#handle = parts.handle
    this.db = parts.handle.db
    this.#booted = parts.booted
    this.services = parts.booted.services
    this.#events = parts.events
    this.github = parts.github
    this.runner = parts.runner
    this.#app = parts.app
    this.#clock = parts.clock
    this.#concurrency = parts.concurrency
  }

  static async open(dataDir: string, publicUrl: string): Promise<Seeder> {
    const handle = await openDatabase(databaseLocation(undefined, dataDir))
    const events = new EventBus()
    const github = new DemoGitHub()
    const clock = { offsetMs: 0 }
    const booted = await boot({
      db: handle.db,
      events,
      spoolDir: join(dataDir, 'spool'),
      blobDir: join(dataDir, 'blobs'),
      github,
      publicUrl,
      now: () => new Date(Date.now() + clock.offsetMs),
      listeners: [{ host: '127.0.0.1', port: 0 }]
    })
    // Every role and slot, so nothing waits on capacity while seeding
    const concurrency = await handle.db.select({ id: schema.agents.id, concurrency: schema.agents.concurrency }).from(schema.agents)
    await handle.db.update(schema.agents).set({ concurrency: 50, wakeIntervalSeconds: null })
    const runner = await FakeRunner.connect(booted.servers[0]!.url, [], 'home-server', { slots: 50 })
    const seeder = new Seeder({ handle, booted, events, github, runner, app: createApp(booted.deps), clock, concurrency })
    runner.onJob = job => seeder.answerJob(job)
    await seeder.#loadShiftSql()
    return seeder
  }

  // What the fake runner answers for setup jobs; scenarios can override
  releaseNotes: (prompt: string) => string = () => 'Release notes'
  // A PR guide's model answer; throwing makes the guide fail
  prGuide: (prompt: string) => string = () => {
    throw new Error('No guide while seeding')
  }

  answerJob(job: Parameters<FakeRunner['onJob']>[0]) {
    switch (job.kind) {
      case 'release_notes': return { kind: 'release_notes' as const, notes: this.releaseNotes(job.prompt) }
      case 'inbox_message': throw new Error('No message while seeding')
      // The fallback title is the first message, which reads fine
      case 'session_title': throw new Error('No title while seeding')
      case 'pr_guide': return { kind: 'pr_guide' as const, text: this.prGuide(job.prompt) }
      default: return answerSetupJob(job)
    }
  }

  async close(): Promise<void> {
    this.runner.close()
    await this.#booted.stop()
    for (const { id, concurrency } of this.#concurrency) await this.db.update(schema.agents).set({ concurrency }).where(eq(schema.agents.id, id))
    await this.#handle.close()
  }

  // Every timestamp moves back by the duration, which is the same as that much
  // time passing: the story is written in order and ends at the present.
  // Leases are left alone, so a run in flight keeps its lease.
  async advance(duration: string): Promise<void> {
    const match = DURATION.exec(duration)
    if (!match) throw new Error(`Bad duration ${duration}`)
    const ms = Math.round(Number(match[1]) * UNITS[match[2] as keyof typeof UNITS])
    const interval = `${ms / 1000} seconds`
    for (const statement of this.#shiftSql) await this.db.execute(sql.raw(statement.replaceAll('$INTERVAL', interval)))
  }

  async #loadShiftSql() {
    const rows = await this.db.execute(sql`
      select table_name, string_agg(format('%I = %I - interval ''$INTERVAL''', column_name, column_name), ', ') as sets
      from information_schema.columns
      where table_schema = 'public' and data_type = 'timestamp with time zone'
        and column_name not like 'lease%' and column_name not in ('paused_until', 'rate_limit_reset_at')
      group by table_name`)
    const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { table_name: string, sets: string }[]
    this.#shiftSql = list.map(r => `update "${r.table_name}" set ${r.sets}`)
  }

  // Lets merge and CI polling see that time has passed for them too
  async mergePass(): Promise<void> {
    this.#clock.offsetMs += LONGEST_POLL_MS + 1_000
    await this.services.orchestrator.mergePass()
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, expected = [200, 201]): Promise<T> {
    const res = await this.#app.request(path, {
      method,
      ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    })
    const text = await res.text()
    if (!expected.includes(res.status)) throw new Error(`${method} ${path}: ${res.status} ${text}`)
    return (text ? JSON.parse(text) : undefined) as T
  }

  async project(input: { name: string, prefix: string, repository: string, defaultBranch?: string, humanReviewDefault?: boolean, epicReviewModeDefault?: EpicReviewMode }): Promise<Project> {
    const project = await this.request<Project>('POST', '/api/projects', { defaultBranch: 'main', ...input })
    this.github.setBranch(project.repository, project.defaultBranch, demoSha(`${project.repository}-root`))
    return project
  }

  async task(project: Project, input: DemoTaskInput): Promise<Task> {
    const { description, implementationPlan, ...rest } = input
    return this.request<Task>('POST', `/api/projects/${project.slug}/tasks`, {
      type: 'task',
      ...rest,
      description: description ? markdownToRichText(description) : null,
      implementationPlan: implementationPlan ? markdownToRichText(implementationPlan) : null
    })
  }

  async get(project: Project, task: Task): Promise<Task> {
    return this.request<Task>('GET', `/api/projects/${project.slug}/tasks/${task.number}`)
  }

  async transition(project: Project, task: Task, body: Record<string, unknown>): Promise<Task> {
    return this.request<Task>('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, body)
  }

  approve(project: Project, task: Task) {
    return this.transition(project, task, { type: 'approve' })
  }

  async comment(project: Project, task: Task, body: string): Promise<void> {
    await this.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/comments`, { body })
  }

  // The first event that matches, published after this is called
  event<T extends ServerEvent>(match: (event: ServerEvent) => event is T, what: string, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const unsubscribe = this.#events.subscribe((event) => {
        if (!match(event)) return
        clearTimeout(timer)
        unsubscribe()
        resolve(event)
      })
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`No ${what} within ${timeoutMs / 1000} s`))
      }, timeoutMs)
    })
  }

  // Asks until the answer is true, for state that changes without an event
  async until(check: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!await check()) {
      if (Date.now() > deadline) throw new Error(`No ${what} within ${timeoutMs / 1000} s`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  async inboxAction(task: Task, body: Record<string, unknown>): Promise<void> {
    await this.request('POST', `/api/inbox/${task.id}/actions`, body)
  }

  async job(match: (job: RunJob) => boolean): Promise<RunJob> {
    await this.services.orchestrator.scheduler.schedule()
    return (await this.runner.next('run.assign', m => match(m.job))).job
  }

  jobFor(task: Task, role: RunJob['role']): Promise<RunJob> {
    return this.job(job => job.taskId === task.id && job.role === role)
  }

  async started(job: RunJob): Promise<void> {
    const handled = runStartHandled(this.#events, job.runId)
    this.runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: `demo-${job.runId}`, initialHeadSha: job.headSha ?? null })
    await handled
  }

  // What the agent did, for its transcript on the run page
  async transcript(job: RunJob, events: RunEvent[], tokens = { inputTokens: 48_000, cacheReadTokens: 310_000, outputTokens: 6_200 }): Promise<void> {
    const handled = this.services.runner.handled(job.runId, 'run.events')
    this.runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [...events, { type: 'usage', ...tokens }] })
    await handled
  }

  async call(job: RunJob, tool: Parameters<FakeRunner['call']>[2], input: unknown): Promise<unknown> {
    const result = await this.runner.call(job.runId, job.leaseEpoch, tool, input)
    if (!result.ok) throw new Error(`${tool} for run ${job.runId}: ${result.error}`)
    return result.result
  }

  async ended(job: RunJob, headSha: string | null = null): Promise<void> {
    const handled = this.services.runner.handled(job.runId, 'run.ended')
    this.runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha })
    await handled
  }

  async evidenceNote(job: RunJob, criterionId: string | null, note: string): Promise<void> {
    await this.call(job, 'attach_evidence', { ...(criterionId && { criterionId }), kind: 'note', note })
  }

  async evidenceFile(job: RunJob, criterionId: string | null, file: { kind: Exclude<EvidenceKind, 'note'>, fileName: string, contentType: string, data: Buffer | string, note: string }): Promise<void> {
    await this.call(job, 'attach_evidence', {
      ...(criterionId && { criterionId }),
      kind: file.kind,
      note: file.note,
      fileName: file.fileName,
      contentType: file.contentType,
      dataBase64: Buffer.from(file.data).toString('base64')
    })
  }

  // The developer pushes its branch and opens (or updates) the PR. The fake
  // GitHub gets the PR's files and checks so the PR pages have something to show.
  async pushed(project: Project, job: RunJob, head: string, options: { files?: PullRequestFile[], checks?: CheckResult[] } = {}): Promise<string> {
    const sha = demoSha(head)
    this.github.setBranch(project.repository, job.branch!, sha)
    this.github.setChecks(sha, options.checks ?? [{ name: 'ci', conclusion: 'success', url: `https://github.com/${project.repository}/actions/runs/${parseInt(sha.slice(0, 7), 16)}` }])
    this.#pendingFiles.set(job.branch!, options.files ?? [])
    return sha
  }

  #pendingFiles = new Map<string, PullRequestFile[]>()

  async reportDeveloper(job: RunJob, input: { outcome: string, summary: string, note: string, headSha?: string, [key: string]: unknown }): Promise<void> {
    await this.call(job, 'report_outcome', input)
    // Attach the PR's files once the server has opened it
    if (job.branch && this.#pendingFiles.has(job.branch)) {
      for (const pr of this.github.pulls.values()) {
        if (pr.head === job.branch) this.github.pullFiles.set(pr.number, this.#pendingFiles.get(job.branch)!)
      }
      this.#pendingFiles.delete(job.branch)
    }
    await this.ended(job, input.headSha ?? null)
  }

  async reportReviewer(job: RunJob, task: Task, outcome: 'approved' | 'changes_requested', summary: string, notes: (string | { met: boolean, note: string })[]): Promise<void> {
    const criteria = task.acceptanceCriteria.filter(c => !c.checkedByHuman).map((c, i) => {
      const verdict = notes[i] ?? 'Checked'
      return typeof verdict === 'string'
        ? { criterionId: c.id, met: outcome === 'approved', note: verdict }
        : { criterionId: c.id, ...verdict }
    })
    await this.call(job, 'report_outcome', { outcome, summary, criteria, ...(job.headSha && { headSha: job.headSha }) })
    await this.ended(job, job.headSha ?? null)
  }

  async planSession(input: { projectId?: string | null, text: string }): Promise<{ session: PlanSessionDetail, job: RunJob }> {
    const session = await this.request<PlanSessionDetail>('POST', '/api/plan/sessions', input)
    const job = (await this.runner.next('run.assign', m => m.job.planSessionId === session.id)).job
    return { session, job }
  }

  async planMessage(sessionId: string, text: string): Promise<RunJob> {
    await this.request('POST', `/api/plan/sessions/${sessionId}/messages`, { text })
    return (await this.runner.next('run.assign', m => m.job.planSessionId === sessionId)).job
  }

  async pmReply(job: RunJob, reply: string, thinking?: string): Promise<void> {
    await this.started(job)
    await this.transcript(job, [...(thinking ? [{ type: 'thinking' as const, text: thinking }] : []), { type: 'message', text: reply }], { inputTokens: 12_000, cacheReadTokens: 84_000, outputTokens: 900 })
    await this.ended(job)
  }

  async session(id: string): Promise<PlanSessionDetail> {
    return this.request<PlanSessionDetail>('GET', `/api/plan/sessions/${id}`)
  }
}
