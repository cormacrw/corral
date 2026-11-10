import type { PlanSessionDetail, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq, ne } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './fake-runner.ts'

const { agents, epics, tasks } = schema

// Parents in plans (D31), over the runner protocol with a fake runner as the PM
describe('plans with tasks with subtasks', () => {
  let t: TestApp
  let runner: FakeRunner
  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })
  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const item = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Task ${key}`, description: 'Build it', type: 'task', acceptanceCriteria: ['It works'], dependsOn: [], ...extra })

  async function start(on: FakeRunner = runner) {
    const project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    return { project, ...await turn(project.id, on) }
  }
  async function turn(projectId: string, on: FakeRunner = runner) {
    const created = await t.request('POST', '/api/plan/sessions', { projectId, text: 'Plan it' }).then(r => r.json()) as PlanSessionDetail
    const { job } = await on.next('run.assign', m => m.job.planSessionId === created.id)
    const propose = (input: Record<string, unknown>) => on.call(job.runId, job.leaseEpoch, 'propose_plan', { title: 'Plan', ...input })
    const plans = async () => (await t.request('GET', `/api/plan/sessions/${created.id}`).then(r => r.json()) as PlanSessionDetail).plans
    return { session: created, job, propose, plans }
  }
  const listed = (slug: string) => t.request('GET', `/api/projects/${slug}/tasks`).then(r => r.json()) as Promise<Task[]>
  const approve = async (plans: () => Promise<{ id: string }[]>, to = 'backlog') => t.request('POST', `/api/plan/plans/${(await plans()).at(-1)!.id}/approve`, { to })

  it('makes a task of two or more subtasks, and takes no task for a single unit of work', async () => {
    const { project, propose, plans } = await start()
    expect(await propose({ parents: [{ key: 'p', title: 'Search', summary: 'Find things', reviewMode: 'each_task' }], tasks: [item('a', { parent: 'p' }), item('b', { parent: 'p' }), item('c', { dependsOn: ['p'] })] })).toMatchObject({ ok: true })
    expect((await approve(plans)).status).toBe(200)
    const all = await listed(project.slug)
    const parent = all.find(task => task.status === 'parent')!
    expect(parent).toMatchObject({ title: 'Search', rollup: { total: 2, reviewMode: 'each_task' } })
    expect(all.filter(task => task.parentTask?.id === parent.id).map(task => task.title)).toEqual(['Task a', 'Task b'])
    // Waiting on a parent in the plan is waiting on its sub-tasks
    const a = all.find(task => task.title === 'Task a')!
    const b = all.find(task => task.title === 'Task b')!
    expect(all.find(task => task.title === 'Task c')!.dependsOn).toEqual([a.ref, b.ref])
  })

  it('refuses a task with one subtask', async () => {
    const { project, propose } = await start()
    const result = await propose({ parents: [{ key: 'p', title: 'Search' }], tasks: [item('a', { parent: 'p' })] })
    expect(result).toMatchObject({ ok: false })
    expect(await listed(project.slug)).toEqual([])
  })

  it('adds to an existing task by its ref', async () => {
    const { project, propose, plans, job } = await start()
    await propose({ parents: [{ key: 'p', title: 'Search' }], tasks: [item('a', { parent: 'p' }), item('b', { parent: 'p' })] })
    await approve(plans)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    const parent = (await listed(project.slug)).find(task => task.status === 'parent')!
    const next = await turn(project.id)
    expect(await next.propose({ tasks: [item('c', { parent: parent.ref })] })).toMatchObject({ ok: true })
    await approve(next.plans)
    const read = await t.request('GET', `/api/tasks/${parent.ref}`).then(r => r.json()) as Task
    expect(read).toMatchObject({ title: 'Search', rollup: { total: 3 } })
  })

  it('promotes a task on approval, keeping its ref and moving its criteria to the first subtask', async () => {
    const { project, propose, plans } = await start()
    const big = await t.createTask(project.slug, { title: 'Big one', acceptanceCriteria: [{ text: 'A human looks', checkedByHuman: true }], humanReview: true })
    expect(await propose({ parents: [{ key: 'p', ref: big.ref }], tasks: [item('a', { parent: 'p' }), item('b', { parent: 'p' })] })).toMatchObject({ ok: true })
    // Until approval the task is untouched
    expect((await t.db.select().from(tasks).where(eq(tasks.id, big.id)))[0]).toMatchObject({ status: 'backlog' })
    await approve(plans)
    const all = await listed(project.slug)
    expect(all.find(task => task.id === big.id)).toMatchObject({ status: 'parent', ref: big.ref, title: 'Big one', acceptanceCriteria: [] })
    const first = all.find(task => task.title === 'Task a')!
    expect(first).toMatchObject({ humanReview: true, parentTask: { ref: big.ref } })
    expect(first.acceptanceCriteria.map(c => [c.text, c.checkedByHuman])).toEqual([['It works', false], ['A human looks', true]])
  })

  it('leaves a task alone when the plan that would promote it is discarded', async () => {
    const { project, propose, plans } = await start()
    const big = await t.createTask(project.slug, { title: 'Big one' })
    await propose({ parents: [{ key: 'p', ref: big.ref }], tasks: [item('a', { parent: 'p' }), item('b', { parent: 'p' })] })
    expect((await t.request('POST', `/api/plan/plans/${(await plans()).at(-1)!.id}/discard`)).status).toBe(200)
    expect((await t.db.select().from(tasks).where(eq(tasks.id, big.id)))[0]).toMatchObject({ status: 'backlog', deletedAt: null })
    expect(await t.db.select().from(epics).where(eq(epics.projectId, project.id))).toEqual([])
  })

  it('refuses to promote a task with a run', async () => {
    const { project, propose } = await start()
    const big = await t.createTask(project.slug, { title: 'Big one' })
    await t.db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, big.id))
    expect(await propose({ parents: [{ key: 'p', ref: big.ref }], tasks: [item('a', { parent: 'p' }), item('b', { parent: 'p' })] })).toMatchObject({ ok: false, error: expect.stringContaining(big.ref) })
  })

  it('can\'t lower an existing task\'s review mode by a plan', async () => {
    const { project, propose, plans, job } = await start()
    await propose({ parents: [{ key: 'p', title: 'Search', reviewMode: 'each_task' }], tasks: [item('a', { parent: 'p' }), item('b', { parent: 'p' })] })
    await approve(plans)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    const parent = (await listed(project.slug)).find(task => task.status === 'parent')!
    const next = await turn(project.id)
    expect(JSON.stringify(await next.propose({ parents: [{ key: 'p', ref: parent.ref, reviewMode: 'direct' }], tasks: [item('c', { parent: 'p' })] }))).toContain('update_parent')
  })
})
