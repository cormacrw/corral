import type { EpicConflictItem, EpicReviewItem, Inbox, TaskInboxItem } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanMessage } from './inbox-message.ts'
import { getEpic } from './epics.ts'
import { loadTask } from './tasks.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { tasks, epics, auditLog, agents, reviews, runs, comments, inboxMessages } = schema
const developer = { kind: 'agent', runId: '00000000-0000-0000-0000-000000000001', role: 'developer' } as const
const long = 'Detailed facts about the work and its remaining problems. '.repeat(100)

describe('stored conversational Inbox messages', () => {
  let t: TestApp
  let runner: FakeRunner | undefined
  let project: Awaited<ReturnType<TestApp['createProject']>>
  let epicId: string
  let reviewerId: string
  let tick = Date.now()
  const at = () => new Date(tick += 1000)
  const captures: unknown[] = []

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    project = await t.createProject({ name: 'Test app', prefix: 'TA', repository: 'cormacrw/test-app', defaultBranch: 'main' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, title: 'Reliable sign-in', description: 'Help people access their account reliably.', createdBy: t.actor }).returning()
    epicId = epic!.id
    reviewerId = (await t.db.select().from(agents).where(eq(agents.role, 'reviewer')))[0]!.id
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
    if (process.env.CORRAL_MESSAGE_EVIDENCE) {
      await mkdir(process.env.CORRAL_MESSAGE_EVIDENCE, { recursive: true })
      await writeFile(join(process.env.CORRAL_MESSAGE_EVIDENCE, 'inbox-api.json'), JSON.stringify(captures, null, 2))
    }
  })

  async function inbox(label: string) {
    const response = await fetch(`${t.server!.url}/api/inbox`)
    const body = await response.json() as Inbox
    captures.push({ scenario: label, request: { method: 'GET', url: `${t.server!.url}/api/inbox` }, status: response.status, response: body })
    return body
  }
  async function item(id: string, label = 'Inbox read') {
    return (await inbox(label)).needsYou.find(i => i.id === id) as TaskInboxItem
  }
  async function enter(id: string, status: 'human_review' | 'blocked' | 'failed', event = 'review_approved', createdAt = at()) {
    const [before] = await t.db.select().from(tasks).where(eq(tasks.id, id))
    await t.db.update(tasks).set({ status, updatedAt: createdAt }).where(eq(tasks.id, id))
    await t.db.insert(auditLog).values({ projectId: project.id, taskId: id, actor: developer, action: 'task.transition', detail: { from: before!.status, to: status, event }, createdAt })
    t.bus.publish({ type: 'task.updated', task: await loadTask(t.db, id) })
  }
  const jobs = () => runner!.received.filter(m => m.type === 'job.request' && m.job.kind === 'inbox_message')
  const nextJob = (text = '') => runner!.next('job.request', m => m.job.kind === 'inbox_message' && m.job.prompt.includes(text))
  const reply = (jobId: string, message: string) => runner!.send({ type: 'job.result', jobId, ok: true, result: { kind: 'inbox_message', message } })

  it('appears immediately without a runner, with problem and epic, keeping the full body', async () => {
    const task = await t.createTask(project.slug, { title: 'Stop password reset links expiring early', epicId })
    await enter(task.id, 'human_review')
    const first = await item(task.id, 'First review, no runner available')
    expect(first.message).toContain('Stop password reset links expiring early')
    expect(first.message).toContain('Reliable sign-in')
    expect(first.message).not.toMatch(/You asked|last review|Work done/)
    expect(first.body).toBe('Approved. This task is marked for human review, so it needs your OK before it merges.')
    expect(first.preview).toBe(first.message!.slice(0, 200))
    expect(first.preview).not.toBe(first.body)
    await expect.poll(async () => (await t.db.select().from(inboxMessages)).length).toBe(1)
    expect((await item(task.id)).message).toBe(first.message)
  })

  it('dispatches once per arrival, includes feedback, ignores stale results and never dispatches on reads', async () => {
    runner = await FakeRunner.connect(t.server!.url)
    const answer = runner.onJob
    runner.onJob = job => job.kind === 'inbox_message' ? null : answer(job)
    const task = await t.createTask(project.slug, { title: 'Keep reset links usable' })
    await enter(task.id, 'human_review')
    const firstJob = await nextJob()
    expect(firstJob.job.kind === 'inbox_message' && firstJob.job.prompt).toContain('"epic":null')
    const first = await item(task.id, 'First review while model is pending; no epic')
    expect(first.message).not.toMatch(/epic|You asked|last review/)
    const count = jobs().length
    await inbox('Repeated read while pending')
    await inbox('Repeated read while pending again')
    expect(jobs()).toHaveLength(count)

    // The human asks for a longer expiry, then the developer reports the fix.
    await t.db.insert(auditLog).values({ projectId: project.id, taskId: task.id, actor: t.actor, action: 'task.transition', detail: { event: 'human_request_changes', from: 'human_review', to: 'in_progress', feedback: 'Keep links valid for an hour' }, createdAt: at() })
    await t.db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, task.id))
    await t.db.insert(comments).values({ taskId: task.id, author: developer, body: 'Extended reset link expiry to one hour', createdAt: at() })
    const [run] = await t.db.insert(runs).values({ projectId: project.id, taskId: task.id, agentId: reviewerId, role: 'reviewer', state: 'completed', endedAt: at(), outcome: 'approved' }).returning()
    await t.db.insert(reviews).values({ taskId: task.id, runId: run!.id, round: 2, headSha: 'fixed', verdict: 'approved', summary: 'Reset links now remain valid for one hour.', author: { kind: 'agent', role: 'reviewer', runId: run!.id } })
    await enter(task.id, 'human_review')
    const secondJob = await nextJob()
    expect(secondJob.job.kind === 'inbox_message' && secondJob.job.prompt).toContain('Extended reset link expiry to one hour')
    const pending = await item(task.id, 'Later review fallback explains request and work done')
    expect(pending.message).toContain('You asked: Keep links valid for an hour')
    expect(pending.message).toContain('Extended reset link expiry to one hour')
    reply(firstJob.jobId, 'Old review of reset links. Please approve the work.')
    await expect.poll(async () => (await t.db.select().from(inboxMessages)).some(m => m.message.startsWith('Old review'))).toBe(true)
    expect((await item(task.id, 'Old model result cannot overwrite the new arrival')).message).toBe(pending.message)
    const generated = 'Reset links need to stay usable. You asked for an hour of validity, and the expiry has been extended to one hour. Please review the fix and approve it or request changes.'
    reply(secondJob.jobId, generated)
    await expect.poll(async () => (await item(task.id)).message).toBe(generated)
    const done = await item(task.id, 'Stored model message after the second review')
    expect(done.preview).toBe(generated.slice(0, 200))
    expect(done.body).toBe(pending.body)
    const remaining = jobs().length
    await inbox('Repeated read after completion')
    t.bus.publish({ type: 'task.updated', task: await loadTask(t.db, task.id) })
    await expect.poll(async () => (await t.db.select().from(inboxMessages)).length).toBe(3)
    expect(jobs()).toHaveLength(remaining)
    captures.push({ scenario: 'Runner dispatches', requests: [firstJob, secondJob], modelReplies: ['Old review of reset links. Please approve the work.', generated], repeatedReadsDispatchedJobs: 0 })
  })

  it('bounds spike, failed, blocked, question and epic messages independently of body length', async () => {
    // Failed model jobs retain the same fallback as pending jobs.
    const answer = (job: Parameters<FakeRunner['onJob']>[0]) => job.kind === 'detect_clis'
      ? { kind: 'detect_clis' as const, clis: [] }
      : null
    runner!.onJob = (job) => {
      if (job.kind === 'inbox_message') throw new Error('Model unavailable')
      return answer(job)
    }
    for (const kind of ['spike', 'failed', 'blocked', 'question'] as const) {
      const task = await t.createTask(project.slug, { title: `Investigate ${kind} sign-in issue`, type: kind === 'spike' ? 'spike' : 'task' })
      await t.db.update(tasks).set({ statusReason: long }).where(eq(tasks.id, task.id))
      if (kind === 'spike') await t.db.insert(comments).values({ taskId: task.id, author: developer, body: `## Findings\n${long}` })
      await enter(task.id, kind === 'spike' ? 'human_review' : kind === 'failed' ? 'failed' : 'blocked', kind === 'question' ? 'stuck' : 'review_approved')
      const failedJob = await nextJob()
      // The reply to this barrier follows the model error on the same socket.
      await t.runner.request({ kind: 'detect_clis' })
      captures.push({ scenario: `${kind}: model failure`, request: failedJob, runnerResponse: { type: 'job.result', jobId: failedJob.jobId, ok: false, error: 'Model unavailable' } })
      const value = await item(task.id, `${kind}: long body with short fallback`)
      expect(value.message!.split(/\s+/).length).toBeLessThanOrEqual(80)
      expect(value.body).toBe(kind === 'spike' ? `## Findings\n${long}` : long)
      expect(value.type).toBe(kind === 'spike' ? 'human_review' : kind)
      expect(value.preview).toBe(value.message!.slice(0, 200))
    }
    const member = await t.createTask(project.slug, { title: 'Sign-in integration', epicId })
    await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, member.id))
    // This epic also holds the earlier review task: finish it for the board.
    await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.epicId, epicId))
    await t.db.update(epics).set({ reviewState: 'human_review', prNumber: 1, prHeadSha: 'combined', updatedAt: at() }).where(eq(epics.id, epicId))
    await t.db.insert(runs).values({ projectId: project.id, epicId, agentId: reviewerId, role: 'reviewer', state: 'completed', endedAt: at(), outcome: 'approved', summary: long })
    await t.db.insert(auditLog).values({ projectId: project.id, actor: developer, action: 'epic.pr', detail: { epicId, event: 'approved', summary: long }, createdAt: at() })
    t.bus.publish({ type: 'epic.updated', epic: await getEpic(t.db, epicId) })
    const review = (await inbox('Epic review with long integration summary')).needsYou.find(i => i.id === epicId) as EpicReviewItem
    expect(review.body).toBe(long)
    expect(review.message!.split(/\s+/).length).toBeLessThanOrEqual(80)
    const oldAt = review.at
    await t.db.update(epics).set({ updatedAt: at() }).where(eq(epics.id, epicId))
    const edited = (await inbox('Editing a waiting epic preserves its arrival')).needsYou.find(i => i.id === epicId)!
    expect(edited.at).toBe(oldAt)
    await t.db.update(epics).set({ reviewState: 'conflict', conflictFiles: Array.from({ length: 200 }, (_, i) => `file-${i}.ts`), updatedAt: at() }).where(eq(epics.id, epicId))
    await t.db.insert(auditLog).values({ projectId: project.id, actor: developer, action: 'epic.pr', detail: { epicId, event: 'conflict' }, createdAt: at() })
    t.bus.publish({ type: 'epic.updated', epic: await getEpic(t.db, epicId) })
    const conflict = (await inbox('Epic conflict with long conflict list')).needsYou.find(i => i.id === epicId) as EpicConflictItem
    expect(conflict.body.length).toBeGreaterThan(1000)
    expect(conflict.message!.split(/\s+/).length).toBeLessThanOrEqual(80)
    expect(conflict.message).toContain('resolve')
  })

  it('distinguishes arrivals with identical timestamps', async () => {
    const task = await t.createTask(project.slug, { title: 'Handle frozen-clock retries' })
    const sameTime = at()
    await enter(task.id, 'human_review', 'review_approved', sameTime)
    const first = await nextJob('Handle frozen-clock retries')
    await t.db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, task.id))
    await enter(task.id, 'human_review', 'review_approved', sameTime)
    const second = await nextJob('Handle frozen-clock retries')
    expect(first.jobId).not.toBe(second.jobId)
    const stored = (await t.db.select().from(inboxMessages)).filter(m => m.arrival.startsWith(task.id))
    expect(stored).toHaveLength(2)
    expect(stored[0]!.arrival).not.toBe(stored[1]!.arrival)
    captures.push({ scenario: 'Two distinct arrivals in one millisecond', requests: [first, second], storedArrivalKeys: stored.map(m => m.arrival) })
  })

  it('rejects empty, overlong and markdown model responses', () => {
    expect(cleanMessage(' ')).toBeNull()
    expect(cleanMessage(long)).toBeNull()
    expect(cleanMessage('# Heading')).toBeNull()
    expect(cleanMessage(' A friendly message.\nPlease review it. ')).toBe('A friendly message. Please review it.')
  })
})
