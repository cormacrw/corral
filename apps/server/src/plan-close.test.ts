import { databaseFixture } from '@corral/db/testing'
import type { PlanSessionDetail } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
databaseFixture('postgres', async () => {
  t = await createTestApp('postgres', { listen: true })
  runner = await FakeRunner.connect(t.server!.url)
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})

it('closes atomically, stops the PM, preserves accepted work and reopens cleanly', async () => {
  const project = await t.createProject()
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
  const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan work' }).then(r => r.json()) as PlanSessionDetail
  const job = (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job
  runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'close-session' })
  await expect.poll(async () => (await t.db.select().from(schema.runs).where(eq(schema.runs.id, job.runId)))[0]!.state).toBe('running')
  const proposed = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', {
    title: 'Work', tasks: ['Draft', 'Ready', 'Backlog', 'In progress'].map((title, i) => ({
      key: `t${i}`, title, description: 'Build it', type: 'task', acceptanceCriteria: ['Works']
    }))
  })
  expect(proposed.ok).toBe(true)
  const rows = await t.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project.id))
  for (const status of ['ready', 'backlog', 'in_progress'] as const) {
    const title = status === 'in_progress' ? 'In progress' : status === 'ready' ? 'Ready' : 'Backlog'
    await t.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, rows.find(r => r.title === title)!.id))
  }
  const before = await t.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project.id))
  const detail = await t.request('GET', `/api/plan/sessions/${created.id}`).then(r => r.json()) as PlanSessionDetail
  expect((await t.request('POST', `/api/plan/sessions/${created.id}/close`)).status).toBe(200)
  expect(await runner.next('run.stop', m => m.runId === job.runId)).toMatchObject({ runId: job.runId })
  expect((await t.db.select().from(schema.runs).where(eq(schema.runs.id, job.runId)))[0]!.state).toBe('interrupted')
  expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', { title: 'Late', tasks: [] })).toMatchObject({ ok: false })
  // An already-dispatched tool must also refuse to write after close,
  // even if it passed the orchestrator's fence before the run stopped.
  await expect(t.plans.tool(created.id, job.runId, 'propose_plan', {
    title: 'Late proposal', tasks: [{ key: 'late', title: 'Late draft', type: 'task', description: 'Build it', acceptanceCriteria: ['Works'] }]
  }, t.actor)).rejects.toThrow('This Plan turn has stopped')
  const after = await t.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project.id))
  expect(after.find(r => r.title === 'Draft')!.deletedAt).not.toBeNull()
  const deleted = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.taskId, rows.find(r => r.title === 'Draft')!.id))
  expect(deleted).toContainEqual(expect.objectContaining({ action: 'task.deleted', detail: expect.objectContaining({ mode: 'soft', reason: 'Discarded with the Plan thread' }) }))
  expect(after.filter(r => r.title !== 'Draft')).toEqual(before.filter(r => r.title !== 'Draft'))
  expect(await t.plans.listDrafts(project.id)).toEqual([])
  expect((await t.request('POST', `/api/plan/plans/${detail.plans[0]!.id}/approve`)).status).toBe(409)
  const closed = await t.plans.getSession(created.id)
  expect(closed).toMatchObject({ closed: true, status: 'none', activeRunId: null })
  expect(closed.plans[0]!.status).toBe('discarded')
  expect(JSON.stringify(await t.request('GET', '/api/inbox').then(r => r.json()))).not.toContain(created.id)
  expect(t.events).toContainEqual(expect.objectContaining({ type: 'plan.session', session: expect.objectContaining({ id: created.id, closed: true }) }))
  expect(t.events).toContainEqual({ type: 'plan.drafts', projectId: project.id, sessions: [] })
  const eventCount = t.events.length
  await t.request('POST', `/api/plan/sessions/${created.id}/close`)
  expect(t.events).toHaveLength(eventCount)
  expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Start again' })).status).toBe(201)
  expect(await t.plans.getSession(created.id)).toMatchObject({ closed: false, status: 'none' })
  expect(await t.plans.listDrafts(project.id)).toEqual([])
})

it('returns not found for a missing session', async () => {
  expect((await t.request('POST', '/api/plan/sessions/00000000-0000-0000-0000-000000000000/close')).status).toBe(404)
})

it('uses draftSessions ownership rather than every task referenced by the closing plan', async () => {
  const project = await t.createProject()
  const [owner, closing] = await t.db.insert(schema.planSessions).values([
    { projectId: project.id, title: 'Owner', createdBy: t.actor },
    { projectId: project.id, title: 'Closing', createdBy: t.actor }
  ]).returning()
  const [draft] = await t.db.insert(schema.tasks).values({
    projectId: project.id, number: 1, type: 'task', title: 'Shared draft', status: 'draft', createdBy: t.actor
  }).returning()
  const [old, proposed] = await t.db.insert(schema.plans).values([
    { projectId: project.id, sessionId: closing!.id, title: 'Earlier reference', version: 1, status: 'superseded' },
    { projectId: project.id, sessionId: owner!.id, title: 'Current owner', version: 1 }
  ]).returning()
  await t.db.insert(schema.planTasks).values([
    { planId: old!.id, taskId: draft!.id, key: 'a', change: 'added', position: 0 },
    { planId: proposed!.id, taskId: draft!.id, key: 'a', change: 'added', position: 0 }
  ])
  await t.request('POST', `/api/plan/sessions/${closing!.id}/close`)
  expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, draft!.id)))[0]!.deletedAt).toBeNull()
  expect(await t.plans.listDrafts(project.id)).toMatchObject([{ sessionId: owner!.id, drafts: [{ taskId: draft!.id }] }])
})

it('leaves an already approved session and its plan unchanged', async () => {
  const project = await t.createProject()
  const [session] = await t.db.insert(schema.planSessions).values({
    projectId: project.id, title: 'Approved', createdBy: t.actor, closedAt: new Date()
  }).returning()
  const [plan] = await t.db.insert(schema.plans).values({
    projectId: project.id, sessionId: session!.id, title: 'Approved', version: 1,
    status: 'approved', approvedBy: t.actor, approvedAt: new Date()
  }).returning()
  const count = t.events.length
  await t.request('POST', `/api/plan/sessions/${session!.id}/close`)
  expect((await t.db.select().from(schema.plans).where(eq(schema.plans.id, plan!.id)))[0]).toEqual(plan)
  expect((await t.db.select().from(schema.planSessions).where(eq(schema.planSessions.id, session!.id)))[0]).toEqual(session)
  expect(t.events).toHaveLength(count)
})

it('detaches accepted dependents from discarded drafts instead of blocking them', async () => {
  const project = await t.createProject()
  const [session] = await t.db.insert(schema.planSessions).values({ projectId: project.id, title: 'Closing', createdBy: t.actor }).returning()
  const [accepted, draft] = await t.db.insert(schema.tasks).values([
    { projectId: project.id, number: 1, type: 'task', title: 'Accepted', status: 'ready', createdBy: t.actor },
    { projectId: project.id, number: 2, type: 'task', title: 'Draft', status: 'draft', createdBy: t.actor }
  ]).returning()
  const [plan] = await t.db.insert(schema.plans).values({ projectId: project.id, sessionId: session!.id, title: 'Work', version: 1 }).returning()
  await t.db.insert(schema.planTasks).values([
    { planId: plan!.id, taskId: accepted!.id, key: 'a', change: 'added', position: 0 },
    { planId: plan!.id, taskId: draft!.id, key: 'b', change: 'added', position: 1 }
  ])
  await t.db.insert(schema.taskDependencies).values({ projectId: project.id, taskId: accepted!.id, dependsOnId: draft!.id })
  expect((await t.request('POST', `/api/plan/sessions/${session!.id}/close`)).status).toBe(200)
  expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, accepted!.id)))[0]).toEqual(accepted)
  expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, draft!.id)))[0]!.deletedAt).not.toBeNull()
  // A dependency on a discarded draft would never merge, so it can't stay
  expect(await t.db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, accepted!.id))).toEqual([])
  expect(await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.taskId, accepted!.id))).toEqual([])
  expect(t.events).toContainEqual({ type: 'task.updated', task: expect.objectContaining({ id: accepted!.id, status: 'ready', dependsOn: [] }) })
})
