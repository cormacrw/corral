import type { Plan, PlanSession, PlanSessionDetail, RunJob, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq, ne } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, epics, runs, tasks } = schema

// The PM over the runner protocol (D9), with a fake runner playing Juno
describe('plan sessions', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('postgres', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const plan = (tasksIn: Partial<{ key: string, title: string, description: string, acceptanceCriteria: string[], dependsOn: string[], humanReview: boolean }>[]) => ({
    title: 'Login',
    summary: 'Email and password login',
    tasks: tasksIn.map((task, i) => ({
      key: `t${i + 1}`,
      title: `Task ${i + 1}`,
      description: 'Build it',
      type: 'backend',
      acceptanceCriteria: ['It works'],
      dependsOn: [],
      ...task
    }))
  })

  // Juno finishes a turn: streams a reply and exits cleanly
  async function endTurn(job: RunJob, reply: string, code = 0) {
    runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: reply }] })
    await sleep(50)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code }, headSha: null })
    await sleep(150)
  }

  async function session(id: string): Promise<PlanSessionDetail> {
    return t.request('GET', `/api/plan/sessions/${id}`).then(r => r.json()) as Promise<PlanSessionDetail>
  }

  it('starts a session with a PM turn, records questions and plans, and approves the plan', async () => {
    const project = await t.createProject()
    const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan a login feature' })
    expect(res.status).toBe(201)
    const created = await res.json() as PlanSessionDetail
    expect(created).toMatchObject({ title: 'Plan a login feature', status: 'none', messages: [{ role: 'human', text: 'Plan a login feature' }] })
    expect(created.activeRunId).not.toBeNull()

    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect(job).toMatchObject({ role: 'pm', taskId: null, agentSessionId: null, repository: project.repository })
    expect(job.prompt).toContain('product-manager agent')
    expect(job.prompt).toContain('Plan a login feature')
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'claude-sess-1' })
    await sleep(100)

    // Tools the PM doesn't have are refused by role
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('can’t use') })

    const board = await runner.call(job.runId, job.leaseEpoch, 'list_tasks', {})
    expect(board).toMatchObject({ ok: true, result: { project: { prefix: project.prefix }, tasks: [] } })

    const question = await runner.call(job.runId, job.leaseEpoch, 'ask_question', { question: 'Magic links too?' })
    expect(question).toMatchObject({ ok: true })
    expect((await session(created.id)).messages.at(-1)).toMatchObject({ role: 'pm', kind: 'question', text: 'Magic links too?' })
    expect((await session(created.id)).status).toBe('question')

    const bad = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ dependsOn: ['t2'] }, { dependsOn: ['t1'] }]))
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('cycle') })
    expect(await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))).toHaveLength(0)

    const good = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Login form' }, { title: 'Session cookie', dependsOn: ['t1'], humanReview: true }]))
    expect(good).toMatchObject({ ok: true, result: { version: 1, tasks: [{ key: 't1', change: 'added' }, { key: 't2', change: 'added' }] } })
    const detail = await session(created.id)
    expect(detail.status).toBe('needs_approval')
    expect(detail.plans).toHaveLength(1)
    const v1 = detail.plans[0]!
    expect(v1).toMatchObject({ version: 1, status: 'proposed', title: 'Login', tasks: [{ title: 'Login form', change: 'added', status: 'backlog', criteriaCount: 1 }, { title: 'Session cookie', dependsOn: [`${project.prefix}-1`] }] })
    expect(detail.messages.at(-1)).toMatchObject({ role: 'pm', planId: v1.id })
    const [epic] = await t.db.select().from(epics).where(eq(epics.id, v1.epicId!))
    expect(epic?.title).toBe('Login')
    const rows = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
    expect(rows.map(r => [r.status, r.humanReview, r.epicId])).toEqual([['backlog', false, epic!.id], ['backlog', true, epic!.id]])

    await endTurn(job, 'I proposed two tasks. Shall I go ahead?')
    const ended = await session(created.id)
    expect(ended.messages.at(-1)).toMatchObject({ role: 'pm', kind: 'message', text: 'I proposed two tasks. Shall I go ahead?' })
    expect(ended.activeRunId).toBeNull()
    expect((await t.db.select().from(runs).where(eq(runs.id, job.runId)))[0]).toMatchObject({ state: 'completed', agentSessionId: 'claude-sess-1' })

    // The next turn resumes the CLI session, with a fallback that carries the record
    const next = await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Drop the cookie task, add logout' })
    expect(next.status).toBe(201)
    const second = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.runId !== job.runId)).job
    expect(second.agentSessionId).toBe('claude-sess-1')
    expect(second.prompt).not.toContain('product-manager agent')
    expect(second.fallbackPrompt).toContain('Conversation so far')
    expect(second.fallbackPrompt).toContain('Magic links too?')

    const v2 = await runner.call(second.runId, second.leaseEpoch, 'propose_plan', plan([{ title: 'Login form', acceptanceCriteria: ['It works', 'Errors are shown'] }, { key: 't3', title: 'Logout', dependsOn: ['t1'] }]))
    expect(v2).toMatchObject({ ok: true, result: { version: 2, tasks: [{ key: 't1', change: 'changed' }, { key: 't3', change: 'added' }, { key: 't2', change: 'removed' }] } })
    const revised = await session(created.id)
    expect(revised.plans.map(p => [p.version, p.status])).toEqual([[1, 'superseded'], [2, 'proposed']])
    const latest = revised.plans[1]!
    expect(latest.tasks.map(x => [x.key, x.change, x.title])).toEqual([['t1', 'changed', 'Login form'], ['t3', 'added', 'Logout'], ['t2', 'removed', 't2']])
    const live = await t.request('GET', `/api/projects/${project.slug}/tasks?view=all`).then(r => r.json()) as Task[]
    expect(live.map(x => [x.title, x.status, x.acceptanceCriteria.length])).toEqual([['Login form', 'backlog', 2], ['Logout', 'backlog', 1]])
    await endTurn(second, 'Updated.')

    // Only a human approves; then every Backlog task is Ready
    const approved = await t.request('POST', `/api/plan/plans/${latest.id}/approve`)
    expect(approved.status).toBe(200)
    expect(await approved.json() as Plan).toMatchObject({ status: 'approved', tasks: [{ status: 'ready' }, { status: 'ready' }, { change: 'removed', status: null }] })
    expect((await session(created.id)).status).toBe('none')
    expect((await t.request('POST', `/api/plan/plans/${latest.id}/approve`)).status).toBe(409)
    const list = await t.request('GET', '/api/plan/sessions').then(r => r.json()) as PlanSession[]
    expect(list.find(s => s.id === created.id)).toMatchObject({ status: 'none', unread: false })
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })

  it('refuses a second turn while one is running, and reports a turn that crashed', async () => {
    const project = await t.createProject()
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Hello' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Again' })).status).toBe(409)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 1 }, headSha: null })
    await sleep(150)
    const detail = await session(created.id)
    expect(detail.messages.at(-1)).toMatchObject({ role: 'pm', kind: 'error', text: 'The PM exited with code 1' })
    expect(detail.activeRunId).toBeNull()
  })

  it('writes a delivery summary when the last task of an epic merges, and marks the session unread', async () => {
    const project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { requiredChecks: ['lint'] })
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Ship it' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Only task' }]))
    await endTurn(job, 'Proposed.')
    const planId = (await session(created.id)).plans[0]!.id
    await t.request('POST', `/api/plan/plans/${planId}/approve`)

    // Developer and reviewer runs, then the merge
    await t.orchestrator.schedule()
    const dev = (await runner.next('run.assign', m => m.job.role === 'developer' && m.job.projectId === project.id)).job
    const task = await t.request('GET', `/api/tasks/${dev.taskRef}`).then(r => r.json()) as Task
    t.github.setBranch(project.repository, dev.branch!, 'abc123')
    await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: task.acceptanceCriteria[0]!.id, kind: 'text', fileName: 'n.txt', contentType: 'text/plain', dataBase64: Buffer.from('x').toString('base64') })
    await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Done', headSha: 'abc123' })
    await t.orchestrator.schedule()
    const review = (await runner.next('run.assign', m => m.job.role === 'reviewer' && m.job.taskId === task.id)).job
    await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Good', criteria: [{ criterionId: task.acceptanceCriteria[0]!.id, met: true, note: '' }] })
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    await t.orchestrator.merges.tick()
    expect((await t.request('GET', `/api/tasks/${dev.taskRef}`).then(r => r.json()) as Task).status).toBe('merged')

    const summary = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id && m.job.runId !== job.runId)).job
    expect(summary.prompt).toContain('delivery summary')
    expect((await session(created.id)).unread).toBe(true)
    await endTurn(summary, 'Login shipped: one task merged.')
    expect((await session(created.id)).messages.at(-1)?.text).toBe('Login shipped: one task merged.')
    expect((await t.request('POST', `/api/plan/sessions/${created.id}/read`).then(r => r.json()) as PlanSession).unread).toBe(false)
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })
})
