import { TASK_INTEGRATION_PROTOCOL, type EpicReviewItem, type Inbox, type RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
beforeAll(async () => {
  t = await createTestApp('pglite', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 50, wakeIntervalSeconds: null })
  runner = await FakeRunner.connect(t.server!.url, [], 'r1', { taskIntegrationProtocols: [TASK_INTEGRATION_PROTOCOL] })
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})

type Created = Awaited<ReturnType<TestApp['createTask']>>
const humanCheck = { text: 'Works on a real iPhone', checkedByHuman: true }
const row = async (id: string) => (await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
const epicRow = async (id: string) => (await t.db.select().from(schema.epics).where(eq(schema.epics.id, id)))[0]!
const inbox = async () => (await t.request('GET', '/api/inbox')).json() as Promise<Inbox>

async function assigned(task: Created, role: RunJob['role']) {
  await t.orchestrator.schedule()
  return (await runner.next('run.assign', m => 'taskId' in m.job && m.job.taskId === task.id && m.job.role === role)).job as RunJob & { branch: string }
}

async function createEpic(mode: 'epic' | 'each_task' = 'epic') {
  const project = await t.createProject()
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Feature', reviewMode: mode }).returning()
  return { project, epic: epic! }
}

async function ready(project: { slug: string }, task: Created) {
  expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
}

// Developer submits and the reviewer approves, judging only agent criteria
async function agentApprove(project: { slug: string, repository: string }, task: Created) {
  await ready(project, task)
  const dev = await assigned(task, 'developer')
  t.github.setBranch(project.repository, dev.branch, `head-${task.id}`)
  const agentCriteria = task.acceptanceCriteria.filter(c => !c.checkedByHuman)
  for (const c of agentCriteria) await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Evidence' })
  expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'commit_submitted', note: 'Done', summary: 'The change', headSha: `head-${task.id}`, baseSha: 'epic-tip' })).toMatchObject({ ok: true })
  const review = await assigned(task, 'reviewer')
  if (agentCriteria.length < task.acceptanceCriteria.length) expect(review.prompt).toContain('who confirms them at the epic review')
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Checked', headSha: `head-${task.id}`, criteria: agentCriteria.map(c => ({ criterionId: c.id, met: true, note: 'Checked' })) })).toMatchObject({ ok: true })
}

// Puts an agent-approved task on the epic branch, as the integrator would
async function integrate(task: Created) {
  const sha = `integrated-${task.id}`
  await t.db.update(schema.tasks).set({ status: 'merged', mergeCommitSha: sha, mergedAt: new Date() }).where(eq(schema.tasks.id, task.id))
  await t.db.update(schema.taskSubmissions).set({ integratedCommitSha: sha, integratedAt: new Date() }).where(eq(schema.taskSubmissions.taskId, task.id))
}

async function toHumanReview(project: { repository: string }, epic: { id: string }) {
  const branch = (await epicRow(epic.id)).branch!
  t.github.setBranch(project.repository, branch, `epic-${epic.id}-${Math.random()}`)
  await t.orchestrator.schedule()
  const job = (await runner.next('run.assign', m => m.job.epicId === epic.id && m.job.role === 'reviewer')).job
  expect(job.prompt).toContain('do not attempt them, produce evidence or verdicts for them')
  expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Integrates cleanly' })).toMatchObject({ ok: true })
  return (await inbox()).needsYou.find(i => i.id === epic.id) as EpicReviewItem
}

it('integrates sensitive and human-check work on agent approval, leaving both to the epic approval', async () => {
  const { project, epic } = await createEpic()
  const flagged = await t.createTask(project.slug, { epicId: epic.id, humanReview: true, acceptanceCriteria: ['Rotates the key'] })
  const checked = await t.createTask(project.slug, { epicId: epic.id, humanReview: false, acceptanceCriteria: ['API works', humanCheck] })
  await agentApprove(project, flagged)
  await agentApprove(project, checked)

  // Ready to merge goes straight to the integrator: no separate human approval
  expect(await row(flagged.id)).toMatchObject({ status: 'ready_to_merge', humanReview: true, integrationProtocol: 1 })
  expect(await row(checked.id)).toMatchObject({ status: 'ready_to_merge', humanReview: false, integrationProtocol: 1 })
  expect((await inbox()).needsYou.some(i => i.taskId === flagged.id || i.taskId === checked.id)).toBe(false)

  const human = checked.acceptanceCriteria.find(c => c.checkedByHuman)!
  await integrate(flagged)
  await integrate(checked)
  const item = await toHumanReview(project, epic)
  const [one, two] = item.tasks
  expect(one).toMatchObject({ humanReview: true, humanChecks: [] })
  expect(two).toMatchObject({ humanReview: false, humanChecks: [human.id] })
  // Commits are linked with no task PR
  expect(two!.task).toMatchObject({ prUrl: null, submission: { sequence: 1, submitted: { sha: `head-${checked.id}`, url: `https://github.com/${project.repository}/commit/head-${checked.id}` }, approved: { sha: `head-${checked.id}` }, integrated: { sha: `integrated-${checked.id}`, url: `https://github.com/${project.repository}/commit/integrated-${checked.id}` } } })
  expect(two!.task.submission!.integratedAt).toEqual(expect.any(String))
  const { branch } = await epicRow(epic.id)
  const pr = [...t.github.pulls.values()].find(p => p.head === branch)!
  expect(pr.body).toContain(`/commit/integrated-${checked.id}`)
  expect(pr.body).toContain('Works on a real iPhone')
  // No evidence or verdict is invented for the human check
  expect(two!.evidence.filter(e => e.criterionId === human.id)).toEqual([])
  expect(two!.task.acceptanceCriteria.find(c => c.id === human.id)).toMatchObject({ met: null, checkedByHuman: true })
  expect(two!.task.latestReview!.criteria.find(c => c.criterionId === human.id)).toMatchObject({ met: null, note: 'Needs human check' })

  const approve = (body: object) => t.request('POST', `/api/epics/${epic.id}/review`, { action: 'approve', headSha: item.headSha, ...body })
  for (const partial of [{}, { confirmedCriteria: [human.id] }, { confirmedTasks: [flagged.id] }]) {
    const refused = await approve(partial)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { constraint: 'human_checks_unconfirmed' } })
    expect((await epicRow(epic.id)).reviewState).toBe('human_review')
  }
  expect((await approve({ confirmedCriteria: [human.id], confirmedTasks: [flagged.id] })).status).toBe(200)
  expect((await epicRow(epic.id)).reviewState).toBe('ready_to_merge')
  const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'epic.pr'))
  expect(audit.map(a => a.detail)).toContainEqual(expect.objectContaining({ epicId: epic.id, event: 'human_approved', confirmedCriteria: [human.id], confirmedTasks: [flagged.id] }))
})

it('sends a new human check on a Ready to merge PR-free task to the epic, not to task review', async () => {
  const { project, epic } = await createEpic()
  const task = await t.createTask(project.slug, { epicId: epic.id, acceptanceCriteria: ['API works'] })
  await agentApprove(project, task)
  const list = [...task.acceptanceCriteria.map(c => ({ id: c.id, text: c.text })), humanCheck]
  expect((await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { acceptanceCriteria: list })).status).toBe(200)
  expect(await row(task.id)).toMatchObject({ status: 'ready_to_merge' })
})

it('keeps a prior approval for Backlog-only work, and invalidates it for board work and a new head', async () => {
  const { project, epic } = await createEpic()
  const task = await t.createTask(project.slug, { epicId: epic.id, acceptanceCriteria: ['API works'] })
  await agentApprove(project, task)
  await integrate(task)
  const item = await toHumanReview(project, epic)
  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'approve', headSha: item.headSha })).status).toBe(200)

  const later = await t.createTask(project.slug, { epicId: epic.id, title: 'Someday' })
  expect(later.status).toBe('backlog')
  expect((await epicRow(epic.id)).reviewState).toBe('ready_to_merge')

  await ready(project, later)
  expect((await epicRow(epic.id)).reviewState).toBe('open')
  await t.db.update(schema.tasks).set({ deletedAt: new Date() }).where(eq(schema.tasks.id, later.id))

  const again = await toHumanReview(project, epic)
  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'approve', headSha: again.headSha })).status).toBe(200)
  const { branch } = await epicRow(epic.id)
  t.github.setBranch(project.repository, branch!, 'someone-pushed')
  await t.orchestrator.epicPrs.reconcile()
  expect(await epicRow(epic.id)).toMatchObject({ reviewState: 'in_review', prHeadSha: 'someone-pushed' })
})

it('keeps task-level human review for standalone work and each_task epics, each with its own PR', async () => {
  const project = await t.createProject()
  const standalone = await t.createTask(project.slug, { humanReview: true, acceptanceCriteria: ['Bug is fixed'] })
  const { project: legacy, epic } = await createEpic('each_task')
  const inEpic = await t.createTask(legacy.slug, { epicId: epic.id, humanReview: false, acceptanceCriteria: ['Works'] })
  for (const [p, task] of [[project, standalone], [legacy, inEpic]] as const) {
    await ready(p, task)
    const dev = await assigned(task, 'developer')
    t.github.setBranch(p.repository, dev.branch, `head-${task.id}`)
    for (const c of task.acceptanceCriteria) await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Evidence' })
    expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Done', summary: 'The change', headSha: `head-${task.id}` })).toMatchObject({ ok: true })
    const opened = await row(task.id)
    expect(opened).toMatchObject({ integrationProtocol: 0, prNumber: expect.any(Number) })
    const review = await assigned(task, 'reviewer')
    expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Checked', criteria: task.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: 'Checked' })) })).toMatchObject({ ok: true })
    expect(await row(task.id)).toMatchObject({ status: 'human_review' })
    expect((await inbox()).needsYou.find(i => i.taskId === task.id)).toMatchObject({ type: 'human_review', prUrl: opened.prUrl })
    expect((await t.request('GET', `/api/projects/${p.slug}/tasks/${task.number}`).then(r => r.json()) as { submission: unknown }).submission).toBeNull()
  }
})
