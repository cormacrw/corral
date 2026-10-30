import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, expectTypeOf, it } from 'vitest'
import { type ApprovePlanCommand, type PlanTaskWrite } from './plan.ts'
import { createTestApp, type TestApp } from './test-app.ts'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp('pglite')
})
afterAll(async () => {
  await t?.close()
})

it('requires complete human approvals and prevents revisions on removed writes', () => {
  expectTypeOf<{ approvedBy: { kind: 'human', userId: string } }>().not.toExtend<ApprovePlanCommand>()
  expectTypeOf<{ approvedAt: Date }>().not.toExtend<ApprovePlanCommand>()
  expectTypeOf<{ approvedBy: { kind: 'agent', agentId: string }, approvedAt: Date }>().not.toExtend<ApprovePlanCommand>()
  type Removed = Extract<PlanTaskWrite, { change: 'removed' }>
  expectTypeOf<Removed['revision']>().toEqualTypeOf<null | undefined>()
  expectTypeOf<{ planId: string, key: string, position: number, change: 'added', taskId: null, revision: null }>().not.toExtend<PlanTaskWrite>()
})

it('loads historical staged items after their task and epic are deleted', async () => {
  const project = await t.createProject()
  const task = await t.createTask(project.slug)
  const [session] = await t.db.insert(schema.planSessions).values({ projectId: project.id, title: 'History', createdBy: t.actor }).returning()
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, title: 'Feature', createdBy: t.actor }).returning()
  const approvedAt = new Date('2026-10-30T12:00:00Z')
  const [plan] = await t.db.insert(schema.plans).values({ sessionId: session!.id, projectId: project.id, epicId: epic!.id, title: 'Plan', version: 1, status: 'approved', approvedBy: t.actor, approvedAt }).returning()
  await t.db.insert(schema.planTasks).values({ planId: plan!.id, taskId: task.id, key: 'existing', change: 'unchanged', position: 0, revision: { title: 'Staged title', description: '', type: 'task', priority: 'medium', humanReview: false, acceptanceCriteria: [], epicId: epic!.id, dependsOn: [] } })
  await t.db.insert(schema.planEpics).values({ planId: plan!.id, epicId: epic!.id, key: 'feature', position: 0 })
  await t.db.delete(schema.tasks).where(eq(schema.tasks.id, task.id))
  await t.db.delete(schema.epics).where(eq(schema.epics.id, epic!.id))
  await t.db.update(schema.plans).set({ status: 'superseded' }).where(eq(schema.plans.id, plan!.id))
  const response = await t.request('GET', `/api/plan/sessions/${session!.id}`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ plans: [{ status: 'superseded', approvedAt: approvedAt.toISOString(), epicId: null, epics: [], tasks: [{ taskId: null, ref: null, revises: true, title: 'Staged title' }] }] })
})
