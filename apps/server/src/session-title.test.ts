import type { PlanSessionDetail, ServerEvent } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanSessionTitle } from './plan.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './fake-runner.ts'

const { agents, planSessions } = schema

// COR-40: a new Plan session gets its fallback title at once, then a short
// one from the runner's `claude` CLI (stubbed here by the fake runner)
describe('session titles', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    // One PM slot: a title job that took it would hold up the turn
    await t.db.update(agents).set({ concurrency: 1 }).where(eq(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
    // Title jobs are answered by each test
    const answer = runner.onJob
    runner.onJob = job => job.kind === 'session_title' ? null : answer(job)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const titleJob = () => runner.next('job.request', m => m.job.kind === 'session_title')
  const session = (id: string) => t.request('GET', `/api/plan/sessions/${id}`).then(r => r.json()) as Promise<PlanSessionDetail>
  const sessionEvents = (id: string) => t.events.filter((e): e is Extract<ServerEvent, { type: 'plan.session' }> => e.type === 'plan.session' && e.session.id === id)

  async function endTurn(sessionId: string) {
    const { job } = await runner.next('run.assign', m => m.job.planSessionId === sessionId)
    runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: 'Sure' }] })
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await expect.poll(async () => (await session(sessionId)).activeRunId).toBeNull()
  }

  it('shows the fallback title at once, starts the PM turn without waiting, then sets the model\'s title live', async () => {
    const project = await t.createProject()
    const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'We need a login page with email and password, plus a forgotten password flow\nMore detail' })
    expect(res.status).toBe(201)
    const created = await res.json() as PlanSessionDetail
    expect(created.title).toBe('We need a login page with email and password, plus a forg…')
    expect(created.activeRunId).toBeNull()

    // The PM turn is assigned while the title job is still unanswered
    const request = await titleJob()
    expect((await runner.next('run.assign', m => m.job.planSessionId === created.id)).job.role).toBe('pm')
    expect(request.job).toMatchObject({ kind: 'session_title', prompt: expect.stringContaining('We need a login page with email and password') })

    runner.send({ type: 'job.result', jobId: request.jobId, ok: true, result: { kind: 'session_title', title: '"Login page with password reset."\n' } })
    await expect.poll(async () => (await session(created.id)).title).toBe('Login page with password reset')
    // The nav, header and Recent all follow this event
    expect(sessionEvents(created.id).at(-1)!.session).toMatchObject({ title: 'Login page with password reset', activeRunId: expect.any(String) })
    expect((await t.request('GET', '/api/plan/sessions').then(r => r.json()) as PlanSessionDetail[]).find(s => s.id === created.id)!.title).toBe('Login page with password reset')
  })

  it('includes the attached task in the title prompt', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { title: 'Dark mode toggle' })
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: '', taskRef: task.ref }).then(r => r.json()) as PlanSessionDetail
    expect(created.title).toContain(task.ref)
    const request = await titleJob()
    const prompt = request.job.kind === 'session_title' ? request.job.prompt : ''
    expect(prompt).toContain(task.ref)
    expect(prompt).toContain('Dark mode toggle')
    runner.send({ type: 'job.result', jobId: request.jobId, ok: true, result: { kind: 'session_title', title: 'Title: Refine the dark mode toggle for settings pages' } })
    await expect.poll(async () => (await session(created.id)).title).toBe('Refine the dark mode toggle for')
    await endTurn(created.id)
  })

  it('keeps the fallback title when the CLI fails, and the session still works', async () => {
    const project = await t.createProject()
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan billing' }).then(r => r.json()) as PlanSessionDetail
    const request = await titleJob()
    runner.send({ type: 'job.result', jobId: request.jobId, ok: false, error: 'claude exited with code 1' })
    await endTurn(created.id)
    expect(await session(created.id)).toMatchObject({ title: 'Plan billing', messages: [{ role: 'human' }, { role: 'pm', text: 'Sure' }] })

    const next = await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'And invoices' })
    expect(next.status).toBe(201)
    await endTurn(created.id)
    // Only the first message asks for a title
    expect(runner.received.some(m => m.type === 'job.request' && m.job.kind === 'session_title')).toBe(false)
    expect((await session(created.id)).title).toBe('Plan billing')
  })

  it('doesn\'t overwrite a title that changed while the model was writing it', async () => {
    // The server's own wait for the title, to know when it has its answer
    const live = t.runner.request.bind(t.runner)
    let answered: Promise<unknown> | undefined
    vi.spyOn(t.runner, 'request').mockImplementation(((job: Parameters<typeof live>[0], ...rest: unknown[]) => {
      const result = (live as (...args: unknown[]) => Promise<unknown>)(job, ...rest)
      if (job.kind === 'session_title') answered = result
      return result
    }) as typeof live)
    const project = await t.createProject()
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan exports' }).then(r => r.json()) as PlanSessionDetail
    const request = await titleJob()
    await t.db.update(planSessions).set({ title: 'My name for it' }).where(eq(planSessions.id, created.id))
    runner.send({ type: 'job.result', jobId: request.jobId, ok: true, result: { kind: 'session_title', title: 'CSV export plan' } })
    await answered
    await endTurn(created.id)
    expect((await session(created.id)).title).toBe('My name for it')
  })
})

describe('cleanSessionTitle', () => {
  it('keeps the first line, without quotes, labels or end punctuation', () => {
    expect(cleanSessionTitle('  "Login page plan."  \nExtra')).toBe('Login page plan')
    expect(cleanSessionTitle('**Title:** Dark mode')).toBe('Dark mode')
    expect(cleanSessionTitle('# `Search` revamp!')).toBe('Search revamp')
    expect(cleanSessionTitle('‘User’s settings page’')).toBe('User’s settings page')
  })

  it('allows at most 6 words and 60 characters', () => {
    expect(cleanSessionTitle('One two three four five six seven')).toBe('One two three four five six')
    const long = cleanSessionTitle('Internationalisation localisation accessibility observability maintainability')!
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long).toBe('Internationalisation localisation accessibility')
    expect(cleanSessionTitle('x'.repeat(80))).toHaveLength(60)
  })

  it('gives null for an empty answer', () => {
    expect(cleanSessionTitle(' \n "" ')).toBeNull()
  })
})
