import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
beforeAll(async () => {
  t = await createTestApp('postgres', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 50, wakeIntervalSeconds: null })
  runner = await FakeRunner.connect(t.server!.url)
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})

it('uses the epic base throughout claim, review, merge and dependent claims on develop', async () => {
  const project = await t.createProject({ defaultBranch: 'develop' })
  t.github.setBranch(project.repository, 'develop', 'target-tip')
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Feature', reviewMode: 'epic' }).returning()
  const first = await t.createTask(project.slug, { epicId: epic!.id, humanReview: false })
  const second = await t.createTask(project.slug, { epicId: epic!.id, dependsOn: [first.number] })
  for (const task of [first, second]) expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
  await t.orchestrator.schedule()
  const dev = (await runner.next('run.assign', m => m.job.taskId === first.id)).job
  const [saved] = await t.db.select().from(schema.epics).where(eq(schema.epics.id, epic!.id))
  expect(dev.baseBranch).toBe(saved!.branch)
  expect(dev.defaultBranch).toBe('develop')
  expect(runner.received.some(m => m.type === 'run.assign' && m.job.taskId === second.id)).toBe(false)
  expect(await t.github.branchHead(project.repository, dev.baseBranch!)).toBe('target-tip')
  expect(dev.prompt).toContain(`based on \`${dev.baseBranch}\``)
  t.github.setBranch(project.repository, dev.branch!, 'task-head')
  for (const c of first.acceptanceCriteria) await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Backend change' })
  expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Feature', headSha: 'task-head' })).toMatchObject({ ok: true })
  const pr = [...t.github.pulls.values()].find(p => p.head === dev.branch)!
  expect(pr.base).toBe(dev.baseBranch)
  await t.orchestrator.schedule()
  const review = (await runner.next('run.assign', m => m.job.taskId === first.id && m.job.role === 'reviewer')).job
  expect(review.prompt).toContain(`against \`${dev.baseBranch}\``)
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Approved', criteria: first.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: 'Checked' })) })).toMatchObject({ ok: true })
  await t.orchestrator.merges.tick()
  expect(await t.github.branchHead(project.repository, 'develop')).toBe('target-tip')
  expect(await t.github.branchHead(project.repository, dev.baseBranch!)).toBe('merge-sha')
  expect(t.github.calls.find(c => c.method === 'merge')?.args[2]).toBe('squash')
  await t.orchestrator.schedule()
  const next = (await runner.next('run.assign', m => m.job.taskId === second.id)).job
  expect(next.baseBranch).toBe(dev.baseBranch)
  expect(await t.github.branchHead(project.repository, next.baseBranch!)).toBe('merge-sha')
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it.each(['each_task', 'epic', 'direct', null] as const)('routes review and conflicts correctly for %s', async (mode) => {
  const project = await t.createProject({ defaultBranch: 'develop' })
  t.github.setBranch(project.repository, 'develop', 'target-tip')
  const [epic] = mode ? await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Review', reviewMode: mode }).returning() : []
  const task = await t.createTask(project.slug, { epicId: epic?.id ?? null, humanReview: false })
  await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
  await t.orchestrator.schedule()
  const dev = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
  t.github.setBranch(project.repository, dev.branch!, `head-${task.id}`)
  for (const c of task.acceptanceCriteria) await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Backend change' })
  expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Done', headSha: `head-${task.id}` })).toMatchObject({ ok: true })
  await t.orchestrator.schedule()
  const review = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Approved', criteria: task.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: '' })) })).toMatchObject({ ok: true })
  const get = async () => (await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`)).json()
  expect((await get()).status).toBe(mode === 'each_task' ? 'human_review' : 'ready_to_merge')
  const pr = [...t.github.pulls.values()].find(p => p.head === dev.branch)!
  expect(pr.base).toBe(mode === 'direct' || !mode ? 'develop' : dev.baseBranch)
  if (mode === 'epic') {
    pr.mergeableState = 'behind'
    t.github.updateBranchResult = false
    await t.orchestrator.merges.tick()
    t.github.updateBranchResult = true
    expect((await get()).status).toBe('in_progress')
    const notes = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))
    expect(notes.at(-1)!.body).toContain(`Rebase onto \`origin/${dev.baseBranch}\``)
  } else if (mode !== 'each_task') {
    await t.orchestrator.merges.tick()
    expect((await get()).status).toBe('merged')
    expect(await t.github.branchHead(project.repository, 'develop')).toBe('merge-sha')
  }
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})
