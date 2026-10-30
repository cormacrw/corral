import type { Inbox, PlanSessionDetail, PlanThreadItem, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, auditLog, planMessages, planSessions, plans, planEpics, planTasks, tasks } = schema

// Open Plan sessions as Plan thread items in the Inbox (D11, amended)
describe('plan threads in the inbox', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(eq(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const inbox = async () => t.request('GET', '/api/inbox').then(r => r.json()) as Promise<Inbox>
  const now = Date.now()
  const at = (minutes: number) => new Date(now - minutes * 60_000)

  async function endTurn(job: RunJob, reply: string) {
    runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: reply }] })
    await sleep(50)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await expect.poll(async () => (await t.request('GET', `/api/plan/sessions/${job.planSessionId}`).then(r => r.json()) as PlanSessionDetail).activeRunId).toBeNull()
  }

  it('lists questions, waiting plans and unread replies in one list with tasks, newest first by when each arrived, and counts every listed item', async () => {
    const project = await t.createProject()
    const session = async (title: string, minutes: number, values: Partial<typeof planSessions.$inferInsert> = {}) => {
      const [row] = await t.db.insert(planSessions).values({ projectId: project.id, title, createdBy: t.actor, updatedAt: at(minutes), ...values }).returning()
      return row!
    }
    const idleOld = await session('Idle, old', 50)
    await t.db.insert(planMessages).values({ sessionId: idleOld.id, role: 'pm', kind: 'message', text: 'Seen already.', createdAt: at(50) })
    await session('Idle, new', 5)
    // Touched after the reply arrived: it's still dated by the reply
    const unread = await session('Unread reply', 1, { unread: true })
    await t.db.insert(planMessages).values({ sessionId: unread.id, role: 'pm', kind: 'message', text: 'Finished investigating.', createdAt: at(40) })
    const question = await session('Question', 2)
    await t.db.insert(planMessages).values({ sessionId: question.id, role: 'pm', kind: 'question', text: 'Magic links too?', recommendation: 'Email only', options: ['Email only', 'Include magic links'], createdAt: at(30) })
    const approval = await session('Needs approval', 3)
    const [plan] = await t.db.insert(plans).values({ sessionId: approval.id, projectId: project.id, version: 2, title: 'Search', summary: 'Find tasks quickly', createdAt: at(10) }).returning()
    await t.db.insert(planMessages).values({ sessionId: approval.id, role: 'pm', kind: 'message', text: 'Plan v2', planId: plan!.id, createdAt: at(10) })
    const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, title: 'Search', createdBy: t.actor }).returning()
    await t.db.insert(planEpics).values({ planId: plan!.id, epicId: epic!.id, key: 'search', position: 0 })
    await t.db.insert(planTasks).values([
      { planId: plan!.id, key: 'index', position: 0, change: 'added' },
      { planId: plan!.id, key: 'ui', position: 1, change: 'unchanged' },
      { planId: plan!.id, key: 'filters', position: 2, change: 'removed' }
    ])
    await session('Closed', 1, { closedAt: at(1), unread: true })
    // With no transition into Blocked on record, the task's updatedAt stands in
    const blocked = await t.createTask(project.slug, { title: 'Blocked task' })
    await t.db.update(tasks).set({ status: 'blocked', statusReason: 'Which API?', updatedAt: at(20) }).where(eq(tasks.id, blocked.id))
    // Dated by its transition into Human review, not by later updates that keep the status
    const review = await t.createTask(project.slug, { title: 'Review task' })
    await t.db.update(tasks).set({ status: 'human_review', updatedAt: at(0) }).where(eq(tasks.id, review.id))
    await t.db.insert(auditLog).values([
      { projectId: project.id, taskId: review.id, actor: t.actor, action: 'task.transition', detail: { event: 'review_approved', from: 'in_review', to: 'human_review' }, createdAt: at(15) },
      { projectId: project.id, taskId: review.id, actor: t.actor, action: 'task.transition', detail: { event: 'head_moved', from: 'human_review', to: 'human_review' }, createdAt: at(4) }
    ])

    const order = ['Needs approval', 'Review task', 'Blocked task', 'Question', 'Unread reply']
    const before = await inbox()
    const mine = before.needsYou.filter(i => i.project?.id === project.id)
    expect(mine.map(i => i.subject)).toEqual(order)
    expect(before.needsYou.map(i => i.at)).toEqual([...before.needsYou.map(i => i.at)].sort().reverse())
    expect(mine.map(i => i.at)).toEqual([at(10), at(15), at(20), at(30), at(40)].map(d => d.toISOString()))
    expect(mine.find(i => i.id === approval.id)).toMatchObject({ type: 'plan_thread', sessionId: approval.id, status: 'needs_approval', planId: plan!.id, unread: false, taskId: null, preview: 'Plan v2', sender: { role: 'pm' }, reply: null })
    expect(mine.find(i => i.id === question.id)).toMatchObject({ type: 'plan_thread', status: 'question', planId: null, question: { text: 'Magic links too?', recommendation: 'Email only', options: ['Email only', 'Include magic links'] }, plan: null, reply: null })
    expect(mine.find(i => i.id === approval.id)).toMatchObject({ question: null, plan: { id: plan!.id, version: 2, title: 'Search', summary: 'Find tasks quickly', epicCount: 1, taskCount: 2 } })
    expect(mine.find(i => i.id === unread.id)).toMatchObject({ type: 'plan_thread', status: 'none', unread: true, question: null, plan: null, reply: 'Finished investigating.' })
    expect(mine.filter(i => i.type === 'plan_thread').every(i => !('body' in i))).toBe(true)
    expect(before.count).toBe(before.needsYou.length)
    expect([...before.activity, ...before.resolved].some(i => (i as { type: string }).type === 'plan_thread')).toBe(false)

    // Reading the unread-only thread takes it out of the list and the count
    const { count } = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    await t.request('POST', `/api/plan/sessions/${unread.id}/read`)
    expect(t.events.at(-1)).toMatchObject({ type: 'plan.session', session: { id: unread.id, unread: false }, markedRead: { inboxCount: count - 1 } })
    const after = await inbox()
    expect(after.count).toBe(before.count - 1)
    expect(after.count).toBe(after.needsYou.length)
    expect(after.needsYou.filter(i => i.project?.id === project.id).map(i => i.subject)).toEqual(order.slice(0, -1))
    await t.db.delete(planSessions).where(eq(planSessions.id, idleOld.id))
  })

  it('follows a session through a question, a plan, approval (which closes it) and a new message, with a plan.session event at each step', async () => {
    const project = await t.createProject()
    const thread = async (id: string) => (await inbox()).needsYou.find((i): i is PlanThreadItem => i.type === 'plan_thread' && i.id === id)
    const lastEvent = (from: number, id: string) => t.events.slice(from).findLast(e => e.type === 'plan.session' && e.session.id === id)

    let mark = t.events.length
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan search' }).then(r => r.json()) as PlanSessionDetail
    // A new session is absent while Juno works
    expect(lastEvent(mark, created.id)).toBeDefined()
    expect(await thread(created.id)).toBeUndefined()
    const job = (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'sess-1' })
    await sleep(50)

    mark = t.events.length
    expect(await runner.call(job.runId, job.leaseEpoch, 'ask_question', { question: 'Fuzzy matching?' })).toMatchObject({ ok: true })
    expect(lastEvent(mark, created.id)).toMatchObject({ session: { status: 'question' } })
    expect(await thread(created.id)).toMatchObject({ status: 'question', preview: 'Fuzzy matching?' })

    mark = t.events.length
    const proposed = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', { title: 'Search', summary: 'A search box', tasks: [{ key: 't1', title: 'Search box', description: 'Build it', type: 'task', acceptanceCriteria: ['It searches'], dependsOn: [] }] }) as { ok: true, result: { planId: string } }
    expect(proposed).toMatchObject({ ok: true })
    expect(lastEvent(mark, created.id)).toMatchObject({ session: { status: 'needs_approval' } })
    expect(await thread(created.id)).toMatchObject({ status: 'needs_approval', planId: proposed.result.planId })

    mark = t.events.length
    await endTurn(job, 'Proposed the plan.')
    expect(lastEvent(mark, created.id)).toMatchObject({ session: { unread: true, activeRunId: null } })
    expect(await thread(created.id)).toMatchObject({ status: 'needs_approval', unread: true, activeRunId: null })
    const counted = (await inbox()).count

    // Approving closes the session: it leaves Needs you and the count, and isn't Resolved
    mark = t.events.length
    expect((await t.request('POST', `/api/plan/plans/${proposed.result.planId}/approve`, { to: 'backlog' })).status).toBe(200)
    expect(lastEvent(mark, created.id)).toMatchObject({ session: { closed: true } })
    const closed = await inbox()
    expect(closed.needsYou.some(i => i.id === created.id)).toBe(false)
    expect(closed.resolved.some(i => i.id === created.id)).toBe(false)
    expect(closed.count).toBe(counted - 1)

    // A new message reopens it
    mark = t.events.length
    expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'One more thing' })).status).toBe(201)
    expect(lastEvent(mark, created.id)).toMatchObject({ session: { closed: false } })
    expect(await thread(created.id)).toBeUndefined()
    const next = (await runner.next('run.assign', m => m.job.planSessionId === created.id && m.job.runId !== job.runId)).job
    await endTurn(next, 'Noted.')
    // Juno's unread reply lists it again, until it's read
    expect(await thread(created.id)).toMatchObject({ status: 'none', unread: true, reply: 'Noted.' })
    await t.request('POST', `/api/plan/sessions/${created.id}/read`)
    expect(await thread(created.id)).toBeUndefined()
  })
})
