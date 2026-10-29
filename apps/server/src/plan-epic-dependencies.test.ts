import type { Plan, PlanSessionDetail } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { claimNextTask } from './claim.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

describe('epic dependencies in plans', { timeout: 30_000 }, () => {
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
    const session = await (await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan mobile delivery' })).json() as PlanSessionDetail
    const { job } = await runner.next('run.assign', m => m.job.planSessionId === session.id)
    const call = (input: unknown) => runner.call(job.runId, job.leaseEpoch, 'propose_plan', input)
    const latest = async () => (await (await t.request('GET', `/api/plan/sessions/${session.id}`)).json() as PlanSessionDetail).plans.at(-1)!
    return { project, job, call, latest }
  }

  const proposal = (dependsOn: string[] | undefined = ['e1']) => ({
    title: 'Mobile delivery', summary: '',
    epics: [
      { key: 'e1', title: 'Mobile PWA', dependsOn: [] as string[] },
      { key: 'e2', title: 'Offline support', ...(dependsOn && { dependsOn }) }
    ],
    tasks: ['e1', 'e2'].map((epic, i) => ({ key: `t${i + 1}`, epic, title: `Build ${epic}`, description: 'Build the feature', type: 'task', acceptanceCriteria: ['Works offline'], dependsOn: [] as string[] }))
  })

  it('snapshots and inherits dependencies, approves keys and existing ids, and gates claims', async () => {
    const { project, job, call, latest } = await setup()
    const [existing] = await t.db.insert(schema.epics).values({ projectId: project.id, title: 'Existing foundation', createdBy: t.actor }).returning()
    expect(await call(proposal(['e1', existing!.id]))).toMatchObject({ ok: true })
    const v1 = await latest()
    expect(v1.epics[1]?.dependsOn?.map(e => e.title)).toEqual(['Mobile PWA', 'Existing foundation'])
    expect(await t.db.select().from(schema.epicDependencies)).toEqual([])
    const revision = proposal()
    delete (revision.epics[1] as { dependsOn?: string[] }).dependsOn
    expect(await call(revision)).toMatchObject({ ok: true })
    const v2 = await latest()
    expect(v2.epics[1]?.dependsOn).toEqual(v1.epics[1]?.dependsOn)
    const approvedResponse = await t.request('POST', `/api/plan/plans/${v2.id}/approve`, { to: 'ready' })
    expect(approvedResponse.status).toBe(200)
    const approved = await approvedResponse.json() as Plan
    const [a, b] = approved.epics
    expect(await t.db.select().from(schema.epicDependencies).where(eq(schema.epicDependencies.epicId, b!.id))).toEqual([
      { epicId: b!.id, dependsOnEpicId: a!.id }, { epicId: b!.id, dependsOnEpicId: existing!.id }
    ])
    expect(await runner.call(job.runId, job.leaseEpoch, 'list_tasks', {})).toMatchObject({ ok: true, result: { epics: expect.arrayContaining([{ id: b!.id, title: 'Offline support', dependsOn: [a!.id, existing!.id] }]) } })
    const [dev] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'developer'))
    await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
    expect(await claimNextTask(t.db, dev!.id, new Date(), [approved.tasks[1]!.taskId!])).toBeNull()
    await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, approved.tasks[0]!.taskId!))
    expect((await claimNextTask(t.db, dev!.id, new Date(), [approved.tasks[1]!.taskId!]))?.taskId).toBe(approved.tasks[1]!.taskId)
  })

  it('rejects unknown, self, cyclic and task/epic deadlocked dependencies with epic names', async () => {
    const { call } = await setup()
    expect(await call(proposal(['missing']))).toMatchObject({ ok: false, error: expect.stringContaining('Offline support') })
    expect(await call(proposal(['e2']))).toMatchObject({ ok: false, error: expect.stringContaining('self_dependency') })
    const cycle = proposal()
    cycle.epics[0]!.dependsOn = ['e2']
    expect(await call(cycle)).toMatchObject({ ok: false, error: expect.stringContaining('Mobile PWA') })
    const deadlock = proposal()
    deadlock.tasks[0]!.dependsOn = ['t2']
    expect(await call(deadlock)).toMatchObject({ ok: false, error: expect.stringContaining('epic_task_deadlock') })
  })

  it('revalidates dependencies at approval and leaves Drafts untouched if a prerequisite disappeared', async () => {
    const { project, call, latest } = await setup()
    const [existing] = await t.db.insert(schema.epics).values({ projectId: project.id, title: 'Temporary foundation', createdBy: t.actor }).returning()
    expect(await call(proposal([existing!.id]))).toMatchObject({ ok: true })
    const plan = await latest()
    await t.db.delete(schema.epics).where(eq(schema.epics.id, existing!.id))
    const response = await t.request('POST', `/api/plan/plans/${plan.id}/approve`, { to: 'ready' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_dependencies', problems: [expect.objectContaining({ code: 'epic_dependency', epics: expect.arrayContaining(['Offline support']) })] } })
    expect((await latest()).status).toBe('proposed')
    expect((await latest()).tasks.map(t => t.status)).toEqual(['draft', 'draft'])
  })

  it('allows explicitly clearing inherited dependencies without changing an earlier version', async () => {
    const { call, latest } = await setup()
    expect(await call(proposal())).toMatchObject({ ok: true })
    const v1 = await latest()
    expect(await call(proposal([]))).toMatchObject({ ok: true })
    const v2 = await latest()
    expect(v2.epics[1]?.dependsOn).toEqual([])
    expect((await t.db.select().from(schema.planEpics).where(eq(schema.planEpics.planId, v1.id)))[1]?.dependsOn).toEqual(['e1'])
  })
})
