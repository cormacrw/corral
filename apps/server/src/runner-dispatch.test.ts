import type { PlanSessionDetail, Project, RunEvent, RunJob, RunnerCapacity, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, runs, tasks } = schema

// Real sockets and database: which runner a job goes to follows its slots,
// roles, runtimes and the runner its task or Plan session last ran on.
describe('runner capacity, runtimes and roles', () => {
  let t: TestApp
  const connections: FakeRunner[] = []
  async function connect(id: string, capacity: Partial<RunnerCapacity> = {}) {
    const runner = await FakeRunner.connect(t.server!.url, [], id, capacity)
    connections.push(runner)
    return runner
  }
  afterEach(async () => {
    for (const r of connections.splice(0)) r.close()
    await t?.close()
  })

  async function readyTask(project: Project, input: Parameters<TestApp['createTask']>[1] = {}): Promise<Task> {
    const task = await t.createTask(project.slug, input)
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
    return t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Promise<Task>
  }

  const assigns = (runner: FakeRunner) => runner.received.filter(m => m.type === 'run.assign')
  const taskRow = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0]!
  const transcript = async (runId: string) => t.request('GET', `/api/runs/${runId}/transcript`).then(r => r.json()) as Promise<RunEvent[]>

  // Whichever of the runners got the matching assignment, taken off the wire
  async function assignedOn(runners: FakeRunner[], match: (job: RunJob) => boolean) {
    const found = await vi.waitFor(() => {
      for (const runner of runners) {
        const message = runner.received.find(m => m.type === 'run.assign' && match(m.job))
        if (message?.type === 'run.assign') return [runner, message] as const
      }
      throw new Error('Not assigned yet')
    })
    found[0].received.splice(found[0].received.indexOf(found[1]), 1)
    return [found[0], found[1].job] as const
  }

  async function started(runner: FakeRunner, job: RunJob, agentSessionId: string) {
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId })
    await vi.waitFor(async () => expect((await t.db.select().from(runs).where(eq(runs.id, job.runId)))[0]!.agentSessionId).toBe(agentSessionId))
  }

  // The developer pushes and reports; the reviewer requests changes
  async function changesRequested(project: Project, task: Task, developer: FakeRunner, job: RunJob, reviewers: FakeRunner[], beforeVerdict = async () => {}) {
    t.github.setBranch(project.repository, job.branch!, 'abc123')
    for (const criterion of task.acceptanceCriteria) {
      await developer.call(job.runId, job.leaseEpoch, 'attach_evidence', {
        criterionId: criterion.id, kind: 'screenshot', note: 'the page', fileName: 'shot.png', contentType: 'image/png', dataBase64: Buffer.from('png').toString('base64')
      })
    }
    expect(await developer.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Implemented', headSha: 'abc123' })).toMatchObject({ ok: true })
    await developer.next('run.stop', m => m.runId === job.runId)
    developer.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'stopped' }, headSha: 'abc123' })
    const [runner, review] = await assignedOn(reviewers, j => j.role === 'reviewer' && j.taskId === task.id)
    await beforeVerdict()
    expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'changes_requested', summary: 'The error message is missing', criteria: [{ criterionId: task.acceptanceCriteria[0]!.id, met: false, note: 'No message shown' }]
    })).toMatchObject({ ok: true })
    runner.send({ type: 'run.ended', runId: review.runId, leaseEpoch: review.leaseEpoch, exit: { kind: 'stopped' }, headSha: null })
  }

  it('fills each runner\'s slots and leaves the next Ready task unclaimed until one frees up', async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 10 }).where(eq(agents.role, 'developer'))
    const a = await connect('A', { slots: 1 })
    const b = await connect('B', { slots: 2 })
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    const ready = [await readyTask(project), await readyTask(project), await readyTask(project)]
    await t.orchestrator.schedule()
    await vi.waitFor(() => expect(assigns(a).length + assigns(b).length).toBe(3))
    expect(assigns(a)).toHaveLength(1)
    expect(assigns(b)).toHaveLength(2)

    const fourth = await readyTask(project)
    await t.orchestrator.schedule()
    await sleep(100)
    expect(assigns(a).length + assigns(b).length).toBe(3)
    expect(await taskRow(fourth.id)).toMatchObject({ status: 'ready', leaseRunId: null })

    // One of B's runs ends (the agent is stuck on a question): its slot takes the fourth task
    const [first] = assigns(b) as Extract<typeof b.received[number], { type: 'run.assign' }>[]
    const job = first!.job
    expect(await b.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', summary: 'Which error copy?' })).toMatchObject({ ok: true })
    b.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'stopped' }, headSha: null })
    const next = await b.next('run.assign', m => m.job.taskId === fourth.id)
    expect(next.job.role).toBe('developer')
    expect(await taskRow(fourth.id)).toMatchObject({ status: 'in_progress', leaseRunId: next.job.runId })
    expect(ready.map(r => r.id)).not.toContain(fourth.id)
    expect((await t.db.select().from(runs).where(eq(runs.id, next.job.runId)))[0]!.runnerId).toBe('B')
  }, 30000)

  it('sends PM turns and design runs only to runners that take those roles', async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 10 }).where(eq(agents.role, 'developer'))
    const a = await connect('A', { roles: ['developer', 'reviewer'] })
    const project = await t.createProject({ repository: 'cormacrw/test-app' })

    // Only A is online: the Plan turn and the design run wait
    const created = await (await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan a login feature' })).json() as PlanSessionDetail
    const design = await readyTask(project, { type: 'design', title: 'Login screen' })
    await t.orchestrator.schedule()
    await sleep(100)
    expect(assigns(a)).toHaveLength(0)
    expect(await taskRow(design.id)).toMatchObject({ status: 'ready', leaseRunId: null })
    const [turn] = await t.db.select().from(runs).where(eq(runs.planSessionId, created.id))
    expect(turn).toMatchObject({ state: 'queued', runnerId: null })

    // B takes every role: Plan carries on there, and so does the design
    const b = await connect('B')
    const pm = await b.next('run.assign', m => m.job.role === 'pm')
    expect(pm.job.planSessionId).toBe(created.id)
    const developer = await b.next('run.assign', m => m.job.taskId === design.id)
    expect(developer.job.taskType).toBe('design')

    // A build task still goes to A
    const build = await readyTask(project)
    await t.orchestrator.schedule()
    await vi.waitFor(() => expect(assigns(a).map(m => m.type === 'run.assign' && m.job.taskId)).toEqual([build.id]))
    expect(assigns(a).every(m => m.type === 'run.assign' && m.job.role === 'developer' && m.job.taskType !== 'design')).toBe(true)
  }, 30000)

  it('sends a codex run only to a runner signed in to codex', async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ runtime: 'codex' }).where(eq(agents.role, 'developer'))
    const a = await connect('A', { runtimes: ['claude-code'] })
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    const task = await readyTask(project)
    await t.orchestrator.schedule()
    await sleep(100)
    expect(assigns(a)).toHaveLength(0)
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready', leaseRunId: null })

    const b = await connect('B', { runtimes: ['claude-code', 'codex'] })
    const job = (await b.next('run.assign', m => m.job.taskId === task.id)).job
    expect(job.runtime).toBe('codex')
    expect(assigns(a)).toHaveLength(0)
  }, 30000)

  it('resumes a developer revision on the runner that ran the previous run', async () => {
    t = await createTestApp('pglite', { listen: true })
    const a = await connect('A', { slots: 1 })
    const b = await connect('B', { slots: 1 })
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    const task = await readyTask(project)
    await t.orchestrator.schedule()
    const [developer, first] = await assignedOn([a, b], j => j.taskId === task.id)
    await started(developer, first, 'session-1')
    await changesRequested(project, task, developer, first, [a, b])

    const revision = (await developer.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
    expect(revision.agentSessionId).toBe('session-1')
    expect(revision.prompt).toContain('This is the same session')
    expect(revision.prompt).toContain('No message shown')
    expect(revision.fallbackPrompt).toContain('This is a revision')
    const other = developer === a ? b : a
    expect(assigns(other).some(m => m.type === 'run.assign' && m.job.role === 'developer')).toBe(false)
    expect(await transcript(revision.runId)).toContainEqual({ type: 'system', text: `Resuming the agent session of run #${first.runNumber} on runner ${developer === a ? 'A' : 'B'}` })
  }, 30000)

  it('starts a revision fresh from the pushed branch on another runner when the previous one is offline', async () => {
    t = await createTestApp('pglite', { listen: true })
    const a = await connect('A', { roles: ['developer'] })
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    const task = await readyTask(project)
    await t.orchestrator.schedule()
    const first = (await a.next('run.assign', m => m.job.taskId === task.id)).job
    await started(a, first, 'session-1')
    // The reviewer runs on B, then A goes away before the revision
    const b = await connect('B', { roles: ['reviewer'] })
    await changesRequested(project, task, a, first, [b], async () => {
      a.close()
      await vi.waitFor(() => expect(t.runner.isOnline('A')).toBe(false))
    })
    const c = await connect('C', { roles: ['developer'] })

    const revision = (await c.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
    expect(revision).toMatchObject({ agentSessionId: null, fallbackPrompt: null, branch: first.branch })
    expect(revision.prompt).toContain('This is a revision')
    expect(revision.prompt).toContain('No message shown')
    expect(await transcript(revision.runId)).toContainEqual({
      type: 'system', text: `Run #${first.runNumber} ran on runner A, which is offline: starting a fresh session on runner C from the pushed branch ${first.branch}`
    })
  }, 30000)

  it('keeps a Plan session\'s turns on the runner of its first turn while it is online', async () => {
    t = await createTestApp('pglite', { listen: true })
    const a = await connect('A')
    const b = await connect('B')
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    const created = await (await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan a login feature' })).json() as PlanSessionDetail
    const [home, firstTurn] = await assignedOn([a, b], j => j.role === 'pm')
    const away = home === a ? b : a

    async function endTurn(runner: FakeRunner, job: RunJob, sessionId: string) {
      runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: sessionId })
      runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: 'Noted.' }] })
      runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
      await vi.waitFor(async () => expect((await t.db.select().from(runs).where(eq(runs.id, job.runId)))[0]!.state).toBe('completed'))
    }
    await endTurn(home, firstTurn, 'pm-session')
    // Both runners are free; each follow-up still goes to the first turn's runner
    for (const text of ['Add a remember-me box', 'And a forgot-password link']) {
      expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text })).status).toBe(201)
      const turn = (await home.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
      expect(turn.agentSessionId).toBe('pm-session')
      await endTurn(home, turn, 'pm-session')
    }
    expect(assigns(away)).toHaveLength(0)

    // Its runner goes away: the next turn cold-starts elsewhere from the saved conversation
    home.close()
    await vi.waitFor(() => expect(t.runner.isOnline(home === a ? 'A' : 'B')).toBe(false))
    expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'One more thing' })).status).toBe(201)
    const moved = (await away.next('run.assign', m => m.job.role === 'pm')).job
    expect(moved).toMatchObject({ agentSessionId: null, fallbackPrompt: null })
    expect(moved.prompt).toContain('One more thing')
    expect(await transcript(moved.runId)).toContainEqual(expect.objectContaining({ type: 'system', text: expect.stringContaining('starting a fresh session on runner') }))
  }, 30000)
})
