import type { Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
const transcript: unknown[] = []
beforeAll(async () => {
  t = await createTestApp('postgres', { listen: true })
  runner = await FakeRunner.connect(t.server!.url)
})
afterEach(async () => {
  await t.orchestrator.schedule()
  await t.db.delete(schema.projects)
})
afterAll(async () => {
  runner?.close()
  await t?.close()
  if (process.env.CORRAL_TASK_METADATA_EVIDENCE_DIR) {
    await writeFile(join(process.env.CORRAL_TASK_METADATA_EVIDENCE_DIR, 'task-metadata-api.json'), JSON.stringify({
      scope: 'Real HTTP and runner WebSocket requests against an isolated test server; GitHub is simulated, no remote writes.',
      exchanges: transcript
    }, null, 2))
  }
})

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(t.server!.url + path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  })
  const result = await response.json()
  transcript.push({ request: { method, path, body }, status: response.status, response: result })
  expect(response.ok).toBe(true)
  return result as Task
}

it.each(['stuck', 'failed'] as const)('rejects missing or blank %s reasons over the runner API and clears the reason on resolve', async (outcome) => {
  const project = await t.createProject({ repository: 'cormacrw/test-app' })
  await request('PATCH', `/api/projects/${project.slug}`, { paused: true, failedRunCap: 1 })
  const task = await t.createTask(project.slug)
  await request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
  await request('PATCH', `/api/projects/${project.slug}`, { paused: false })
  await t.orchestrator.schedule()
  const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
  await request('PATCH', `/api/projects/${project.slug}`, { paused: true })
  const report = async (summary?: string) => {
    const input = { outcome, note: 'Inspected task requirements', ...(summary !== undefined && { summary }) }
    const response = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', input)
    transcript.push({ request: { transport: 'runner WebSocket', tool: 'report_outcome', runId: job.runId, input }, response })
    return response
  }
  for (const summary of [undefined, '', ' \t\n']) {
    expect(await report(summary)).toMatchObject({ ok: false })
    const unchanged = await request('GET', `/api/tasks/${task.ref}`)
    expect(unchanged).toMatchObject({ status: 'in_progress', statusReason: null, draftSession: null, pr: null })
  }
  expect(await report('  Which authentication provider?  ')).toMatchObject({ ok: true })
  const stopped = await request('GET', `/api/tasks/${task.ref}`)
  expect(stopped).toMatchObject({
    status: outcome === 'stuck' ? 'blocked' : 'failed',
    draftSession: null, pr: null, lease: null,
    statusReason: outcome === 'stuck' ? 'Which authentication provider?' : 'Failed-run cap reached (1)'
  })
  const resolved = await request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'resolve', to: 'in_progress' })
  expect(resolved).toMatchObject({ status: 'in_progress', statusReason: null, draftSession: null, pr: null, lease: null })
  await t.db.delete(schema.projects).where(eq(schema.projects.id, project.id))
})

it('exposes grouped Draft ownership and removes it from HTTP and SSE when the task leaves Draft', async () => {
  const project = await t.createProject({ repository: 'cormacrw/test-app' })
  await request('PATCH', `/api/projects/${project.slug}`, { paused: true })
  const task = await t.createTask(project.slug)
  await t.db.update(schema.tasks).set({ status: 'draft' }).where(eq(schema.tasks.id, task.id))
  const [session] = await t.db.insert(schema.planSessions).values({ projectId: project.id, title: 'Plan authentication', createdBy: t.actor }).returning()
  const [plan] = await t.db.insert(schema.plans).values({ projectId: project.id, sessionId: session!.id, version: 1, title: 'Authentication plan' }).returning()
  await t.db.insert(schema.planTasks).values({ planId: plan!.id, taskId: task.id, key: 'auth', change: 'added', position: 0 })
  expect(await request('GET', `/api/tasks/${task.ref}`)).toMatchObject({ status: 'draft', draftSession: { id: session!.id, title: session!.title } })
  expect(await request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'accept' })).toMatchObject({ status: 'backlog', draftSession: null })
  expect(await request('GET', `/api/tasks/${task.ref}`)).toMatchObject({ status: 'backlog', draftSession: null })
  const event = t.events.findLast(e => e.type === 'task.updated' && e.task.id === task.id)
  expect(event).toMatchObject({ type: 'task.updated', task: { status: 'backlog', draftSession: null } })
  transcript.push({ event })
  await t.db.delete(schema.projects).where(eq(schema.projects.id, project.id))
})

it('keeps complete PR pairs in the task DTO and allows finished spikes and designs without PRs', async () => {
  const project = await t.createProject({ repository: 'cormacrw/test-app' })
  await request('PATCH', `/api/projects/${project.slug}`, { paused: true })
  const task = await t.createTask(project.slug)
  await t.db.update(schema.tasks).set({ prNumber: 123, prUrl: 'https://github.com/cormacrw/test-app/pull/123' }).where(eq(schema.tasks.id, task.id))
  expect(await request('GET', `/api/tasks/${task.ref}`)).toMatchObject({
    pr: { number: 123, url: 'https://github.com/cormacrw/test-app/pull/123' }, draftSession: null
  })
  for (const type of ['spike', 'design'] as const) {
    await t.db.update(schema.tasks).set({ type, status: 'merged', prNumber: null, prUrl: null }).where(eq(schema.tasks.id, task.id))
    expect(await request('GET', `/api/tasks/${task.ref}`)).toMatchObject({ type, status: 'merged', pr: null, draftSession: null, lease: null })
  }
})
