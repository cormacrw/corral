import type { PlanSessionDetail } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

interface Board {
  epics: { id: string, dependsOn: string[] }[]
  tasks: Record<string, unknown>[]
}

describe('list_tasks', { timeout: 30_000 }, () => {
  let t: TestApp
  let runner: FakeRunner
  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    runner = await FakeRunner.connect(t.server!.url)
  })
  afterEach(async () => {
    await t.orchestrator.schedule()
    await t.db.delete(schema.projects)
  })
  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  async function setup() {
    const project = await t.createProject({ repository: 'cormacrw/test-app', defaultBranch: 'main' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const [first] = await t.db.insert(schema.epics).values({ projectId: project.id, title: 'First', createdBy: t.actor }).returning()
    const [second] = await t.db.insert(schema.epics).values({ projectId: project.id, title: 'Second', createdBy: t.actor }).returning()
    await t.db.insert(schema.epicDependencies).values({ projectId: project.id, epicId: second!.id, dependsOnEpicId: first!.id })
    const login = await t.createTask(project.slug, { title: 'Login form', type: 'task', priority: 'high', epicId: first!.id })
    const logout = await t.createTask(project.slug, { title: 'Logout button', type: 'bug', dependsOn: [login.number] })
    const shipped = await t.createTask(project.slug, { title: 'Shipped work' })
    await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, shipped.id))
    await t.db.update(schema.tasks).set({ status: 'ready' }).where(eq(schema.tasks.id, logout.id))
    const session = await (await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'What is on the board?' })).json() as PlanSessionDetail
    const { job } = await runner.next('run.assign', m => m.job.planSessionId === session.id)
    const list = async (input: Record<string, unknown> = {}) => {
      const outcome = await runner.call(job.runId, job.leaseEpoch, 'list_tasks', input) as { ok: true, result: Board }
      return outcome.result
    }
    const refs = async (input: Record<string, unknown> = {}) => (await list(input)).tasks.map(row => row.ref)
    const ref = (n: number) => `${project.prefix}-${n}`
    return { list, refs, ref, first: first!, second: second!, job }
  }

  it('leaves out Merged tasks by default and returns compact rows', async () => {
    const { list, ref, first, second } = await setup()
    const board = await list()
    expect(board.tasks).toEqual([
      { ref: ref(1), title: 'Login form', status: 'backlog', type: 'task', priority: 'high', epicId: first.id, dependsOn: [] },
      { ref: ref(2), title: 'Logout button', status: 'ready', type: 'bug', priority: 'medium', epicId: null, dependsOn: [ref(1)] }
    ])
    expect(board.epics).toEqual(expect.arrayContaining([expect.objectContaining({ id: second.id, dependsOn: [first.id] })]))
  })

  it('filters by status, epic and query, and combines them', async () => {
    const { refs, ref, first, second } = await setup()
    expect(await refs({ status: 'ready' })).toEqual([ref(2)])
    expect(await refs({ status: ['backlog', 'ready'] })).toEqual([ref(1), ref(2)])
    expect(await refs({ status: 'merged' })).toEqual([ref(3)])
    expect(await refs({ epic: first.id })).toEqual([ref(1)])
    expect(await refs({ epic: second.id })).toEqual([])
    expect(await refs({ epic: 'not-a-uuid' })).toEqual([])
    expect(await refs({ query: 'LOGOUT' })).toEqual([ref(2)])
    expect(await refs({ query: ref(1).toLowerCase() })).toEqual([ref(1)])
    expect(await refs({ query: 'log', status: 'backlog' })).toEqual([ref(1)])
  })

  it('includes Merged tasks with includeMerged, and epics stay whatever the filter', async () => {
    const { list, refs, ref, second } = await setup()
    expect(await refs({ includeMerged: true })).toEqual([ref(1), ref(2), ref(3)])
    expect(await refs({ includeMerged: true, query: 'shipped' })).toEqual([ref(3)])
    expect(await refs({ query: 'shipped' })).toEqual([])
    expect((await list({ query: 'nothing matches' })).epics).toEqual(expect.arrayContaining([expect.objectContaining({ id: second.id })]))
  })

  it('refuses a status that does not exist', async () => {
    const { job } = await setup()
    expect(await runner.call(job.runId, job.leaseEpoch, 'list_tasks', { status: 'done' })).toMatchObject({ ok: false, error: expect.stringContaining('not listed') })
  })
})
