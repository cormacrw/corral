import type { PlanSessionDetail } from '@corral/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
beforeAll(async () => {
  t = await createTestApp('pglite', { listen: true })
  runner = await FakeRunner.connect(t.server!.url)
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})

it('attaches PM files to chat or a project task, validating scope, criteria and size', async () => {
  const project = await t.createProject({ name: 'Test app', prefix: 'TA', repository: 'cormacrw/test-app', defaultBranch: 'main' })
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
  const task = await t.createTask(project.slug)
  const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Review the attached research' }).then(r => r.json()) as PlanSessionDetail
  const job = (await runner.next('run.assign', m => m.job.role === 'pm')).job
  const upload = { kind: 'text', note: 'Research notes', fileName: 'research.txt', contentType: 'text/plain', dataBase64: Buffer.from('PM research').toString('base64') }
  const chat = await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', upload)
  expect(chat).toMatchObject({ ok: true, result: { id: expect.any(String) } })
  const detail = await t.request('GET', `/api/plan/sessions/${created.id}`).then(r => r.json()) as PlanSessionDetail
  const text = detail.messages.at(-1)!.text
  expect(text).toContain('[research.txt](/api/evidence/')
  expect(t.events.some(e => e.type === 'plan.message' && e.message.text === text)).toBe(true)
  const url = /\]\(([^)]+)\)/.exec(text)![1]!
  expect(await t.request('GET', url).then(r => r.text())).toBe('PM research')

  const onTask = await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { ...upload, taskRef: task.ref, criterionId: task.acceptanceCriteria[0]!.id })
  expect(onTask).toMatchObject({ ok: true })
  const items = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/evidence`).then(r => r.json())
  expect(items).toMatchObject([{ taskId: task.id, fileName: 'research.txt', criterionId: task.acceptanceCriteria[0]!.id }])
  for (const ref of ['OTHER-1', `${project.prefix}-9999`]) {
    const refused = await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { ...upload, taskRef: ref })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining(`No task ${ref} in this project`) })
    expect(await runner.call(job.runId, job.leaseEpoch, 'add_comment', { taskRef: ref, body: 'Context' })).toMatchObject({ error: refused.error })
  }
  expect((await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { ...upload, criterionId: task.acceptanceCriteria[0]!.id })).ok).toBe(false)
  expect((await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { ...upload, taskRef: task.ref, criterionId: '00000000-0000-4000-8000-000000000000' })).ok).toBe(false)
  expect(await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { ...upload, dataBase64: Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64') })).toMatchObject({ ok: false, error: 'Evidence files are limited to 25 MB' })
})
