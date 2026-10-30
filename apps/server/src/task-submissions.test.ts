import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { recordTaskSubmission } from './task-submissions.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp('pglite', { listen: true })
})
afterAll(async () => {
  await t?.close()
})

async function fixture(mode: 'epic' | 'each_task' | 'direct' = 'epic', type: 'task' | 'spike' | 'design' = 'task') {
  const project = await t.createProject()
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, title: 'Feature', reviewMode: mode, branch: 'corral/epic-feature', createdBy: t.actor }).returning()
  const task = await t.createTask(project.slug, { epicId: epic!.id, type })
  await t.db.update(schema.tasks).set({ branch: 'corral/task' }).where(eq(schema.tasks.id, task.id))
  return { project, epic: epic!, task }
}

it('persists submitted, agent-approved and integrated commits without a PR, retaining revisions and operation intent', async () => {
  const { task, epic } = await fixture()
  const first = await recordTaskSubmission(t.db, { taskId: task.id, submittedHeadSha: 'head-1', baseSha: 'base-1' })
  const second = await recordTaskSubmission(t.db, { taskId: task.id, submittedHeadSha: 'head-2', baseSha: 'base-2' })
  expect(second.sequence).toBe(2)
  expect((await t.request('PATCH', `/api/epics/${epic.id}`, { reviewMode: 'direct' })).status).toBe(409)
  expect(await (await t.request('GET', `/api/epics/${epic.id}`)).json()).toMatchObject({ reviewModeLocked: true, reviewMode: 'epic' })
  await expect(t.db.update(schema.taskSubmissions).set({ agentApprovedHeadSha: 'wrong-head' }).where(eq(schema.taskSubmissions.id, second.id))).rejects.toThrow()
  await expect(t.db.update(schema.taskSubmissions).set({ integratedCommitSha: 'integrated', integratedAt: new Date() }).where(eq(schema.taskSubmissions.id, second.id))).rejects.toThrow()
  await t.db.update(schema.taskSubmissions).set({ agentApprovedHeadSha: 'head-2' }).where(eq(schema.taskSubmissions.id, second.id))
  const operation = { submissionId: second.id, kind: 'integrate' as const, expectedTargetSha: 'epic-head', runnerId: 'r1', leaseEpoch: 2 }
  const [op] = await t.db.insert(schema.taskIntegrationOperations).values(operation).returning()
  await expect(t.db.insert(schema.taskIntegrationOperations).values(operation)).rejects.toThrow()
  await t.db.update(schema.taskIntegrationOperations).set({ state: 'reconciling' }).where(eq(schema.taskIntegrationOperations.id, op!.id))
  await expect(t.db.insert(schema.taskIntegrationOperations).values(operation)).rejects.toThrow()
  await t.db.transaction(async (tx) => {
    await tx.update(schema.taskIntegrationOperations).set({ state: 'succeeded', resultHeadSha: 'integrated' }).where(eq(schema.taskIntegrationOperations.id, op!.id))
    await tx.update(schema.taskSubmissions).set({ integratedCommitSha: 'integrated', integratedAt: new Date() }).where(eq(schema.taskSubmissions.id, second.id))
  })
  expect(await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.id, first.id))).toMatchObject([{ agentApprovedHeadSha: null, integratedCommitSha: null }])
  expect(await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.id, second.id))).toMatchObject([{ submittedHeadSha: 'head-2', agentApprovedHeadSha: 'head-2', integratedCommitSha: 'integrated' }])
  expect(await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))).toMatchObject([{ prNumber: null, prUrl: null, integrationProtocol: 1 }])
})

it.each(['direct', 'each_task', 'spike', 'design', 'existing-pr', 'standalone', 'epic-conflict'] as const)('keeps %s on its explicit existing path', async (path) => {
  const { task } = await fixture(path === 'direct' || path === 'each_task' ? path : 'epic', path === 'spike' || path === 'design' ? path : 'task')
  if (path === 'existing-pr') await t.db.update(schema.tasks).set({ prNumber: 42, prUrl: 'https://github.com/cormacrw/test-app/pull/42' }).where(eq(schema.tasks.id, task.id))
  if (path === 'standalone') await t.db.update(schema.tasks).set({ epicId: null }).where(eq(schema.tasks.id, task.id))
  if (path === 'epic-conflict') await t.db.update(schema.tasks).set({ branch: 'corral/epic-feature' }).where(eq(schema.tasks.id, task.id))
  await expect(recordTaskSubmission(t.db, { taskId: task.id, submittedHeadSha: 'head', baseSha: 'base' })).rejects.toThrow('existing path')
  expect(await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))).toMatchObject([{ integrationProtocol: 0 }])
})

it('gives a legacy runner an actionable reason over WebSocket and leaves unsupported work unclaimed', async () => {
  const { task, project } = await fixture()
  await t.db.update(schema.tasks).set({ status: 'ready', integrationProtocol: 1 }).where(eq(schema.tasks.id, task.id))
  const runner = await FakeRunner.connect(t.server!.url)
  try {
    const status = t.runner.status().runners.find(r => r.id === 'r1')!
    expect(status.integrationCompatibilityReason).toContain('Update the runner')
    expect(status.taskIntegrationProtocols).toEqual([])
    await t.db.update(schema.agents).set({ wakeIntervalSeconds: null })
    await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
    await t.orchestrator.schedule()
    const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(row).toMatchObject({ status: 'ready', leaseRunId: null, leaseEpoch: 0 })
    expect(runner.received.some(m => m.type === 'run.assign' && m.job.taskId === task.id)).toBe(false)
  } finally { runner.close() }
})
