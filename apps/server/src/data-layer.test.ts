import type { Inbox, Project, Task, TaskInboxItem } from '@corral/contracts'
import { schema } from '@corral/db'
import { databaseFixture, requireDatabase } from '@corral/db/testing'
import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { appendAudit, auditEvent } from './audit.ts'
import { epicInboxItems, unclaimedEpicItems } from './epic-prs.ts'
import { loadEpic } from './epics.ts'
import { loadInbox, unclaimedTaskItems } from './inbox.ts'
import { createAgent } from './runs.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { deleteTaskRows, loadTask, loadTasks } from './tasks.ts'

const { agents, auditLog, comments, epics, inboxMessages, planMessages, planSessions, reviews, runs, tasks } = schema
const system = { kind: 'system', component: 'server' } as const

describe.each(['pglite', 'postgres'] as const)('the data layer on %s', (driver) => {
  let t: TestApp
  let project: Project
  databaseFixture(driver, async () => {
    t = await createTestApp(driver)
    project = await t.createProject({ repository: 'cormacrw/test-app' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
  })
  afterAll(async () => {
    await t?.close()
  })

  const agent = async (role: 'developer' | 'reviewer') => (await t.db.select().from(agents).where(eq(agents.role, role)))[0]!
  const inbox = async () => t.request('GET', '/api/inbox').then(r => r.json()) as Promise<Inbox>
  const setStatus = async (taskId: string, status: typeof tasks.$inferInsert['status'], from: string | null = null) => {
    await t.db.update(tasks).set({ status, statusReason: status === 'blocked' || status === 'failed' ? 'Waiting' : null }).where(eq(tasks.id, taskId))
    if (from) await appendAudit(t.db, { projectId: project.id, taskId, actor: system }, auditEvent('task.transition', { event: 'stuck', from, to: status! } as never))
  }

  it('leaves no answer pinned when the human\'s transition is rejected', async () => {
    const task = await t.createTask(project.slug)
    await setStatus(task.id, 'merged')
    const res = await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'clarify', text: 'Use Postgres' })
    expect(res.status).toBe(409)
    expect(await t.db.select().from(comments).where(eq(comments.taskId, task.id))).toEqual([])
  })

  it('still finds an answer pinned in the same transaction as its transition', async () => {
    const task = await t.createTask(project.slug)
    await setStatus(task.id, 'blocked', 'in_progress')
    // Comparisons are to the millisecond, and no human answers within one
    await new Promise(resolve => setTimeout(resolve, 2))
    expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'clarify', text: 'Use Postgres' })).status).toBe(200)
    // Stamped with the audit entry's time; a later clock would lose the answer
    await setStatus(task.id, 'blocked', 'in_progress')
    const item = (await inbox()).needsYou.find(i => i.taskId === task.id) as TaskInboxItem
    expect(item.since?.text).toBe('Use Postgres')
  })

  it('pins an answer to a resolve only when it has text', async () => {
    const pinned = async (text?: string) => {
      const task = await t.createTask(project.slug)
      await setStatus(task.id, 'blocked', 'in_progress')
      expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'resolve', to: 'ready', ...(text !== undefined && { text }) })).status).toBe(200)
      expect((await t.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('ready')
      return (await t.db.select().from(comments).where(eq(comments.taskId, task.id))).map(c => [c.body, c.pinned])
    }
    expect(await pinned()).toEqual([])
    expect(await pinned('   ')).toEqual([])
    expect(await pinned('Use Postgres')).toEqual([['Use Postgres', true]])
  })

  it('names the latest review and agents per task and role when loading many', async () => {
    const [one, two] = [await t.createTask(project.slug), await t.createTask(project.slug)] as [Task, Task]
    const developer = await agent('developer')
    const [newer] = await t.db.insert(agents).values({ name: 'Newer', role: 'developer', runtime: 'claude-code' }).returning()
    const reviewer = await agent('reviewer')
    const run = async (taskId: string, agentId: string, role: 'developer' | 'reviewer', minutes: number) => (await t.db.insert(runs).values({ projectId: project.id, taskId, agentId, role, queuedAt: new Date(Date.now() - minutes * 60_000) }).returning())[0]!
    await run(one.id, developer.id, 'developer', 10)
    await run(one.id, newer!.id, 'developer', 5)
    await run(two.id, developer.id, 'developer', 1)
    const reviewRun = await run(one.id, reviewer.id, 'reviewer', 4)
    const verdict = (summary: string, minutes: number) => ({ taskId: one.id, runId: reviewRun.id, round: 1, headSha: 'abc', verdict: 'approved' as const, summary, author: system, createdAt: new Date(Date.now() - minutes * 60_000) })
    await t.db.insert(reviews).values([verdict('Older', 3), verdict('Latest', 2)])

    const [first, second] = await loadTasks(t.db, [two.id, 'c9f7d1b0-0000-4000-8000-000000000000', one.id])
    expect(second).toMatchObject({ id: one.id, developer: { name: 'Newer' }, reviewer: { name: reviewer.name }, latestReview: { summary: 'Latest' } })
    expect(first).toMatchObject({ id: two.id, developer: { name: developer.name }, reviewer: null, latestReview: null })
    expect(await loadTask(t.db, one.id)).toEqual(second)
  }, 30_000)

  it('keys an arrival by the highest audit ID in its millisecond, and stops at a stored message', async () => {
    const task = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'failed', statusReason: 'Waiting' }).where(eq(tasks.id, task.id))
    const at = new Date('2026-10-30T09:00:00.123Z')
    const entry = { projectId: project.id, taskId: task.id, actor: system, action: 'task.transition', createdAt: at }
    const [low, high] = await t.db.insert(auditLog).values([
      { ...entry, detail: { event: 'run_failed', from: 'in_progress', to: 'failed' } },
      { ...entry, detail: { event: 'run_failed', from: 'in_progress', to: 'failed' } }
    ]).returning({ id: auditLog.id })
    expect(high!.id).toBeGreaterThan(low!.id)

    const arrival = `${task.id}:failed:audit-${high!.id}`
    expect((await unclaimedTaskItems(t.db, task.id)).map(p => p.arrival)).toEqual([arrival])
    await t.db.insert(inboxMessages).values({ arrival, message: 'Stored before the bulk read' })
    expect((await inbox()).needsYou.find(i => i.taskId === task.id)).toMatchObject({ message: 'Stored before the bulk read', at: at.toISOString() })
    expect(await unclaimedTaskItems(t.db, task.id)).toEqual([])
    await t.db.update(tasks).set({ status: 'merged', statusReason: null }).where(eq(tasks.id, task.id))
  })

  it('keeps the epic arrival key, and counts Needs you as the Inbox lists it', async () => {
    const [conflict] = await t.db.insert(epics).values({ projectId: project.id, title: 'Conflicted', description: '', createdBy: t.actor, reviewState: 'conflict', prNumber: 3, prHeadSha: 'abc' }).returning()
    // Waiting for its reviewer's approval, so not listed
    await t.db.insert(epics).values({ projectId: project.id, title: 'Unreviewed', description: '', createdBy: t.actor, reviewState: 'human_review', prNumber: 4, prHeadSha: 'abc' })
    await appendAudit(t.db, { projectId: project.id, actor: system }, auditEvent('epic.pr', { epicId: conflict!.id, event: 'conflict', summary: '', files: [] }))
    const [entry] = await t.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, 'epic.pr')).orderBy(sql`${auditLog.id} desc`).limit(1)
    expect((await unclaimedEpicItems(t.db, conflict!.id)).map(p => p.arrival)).toEqual([`${conflict!.id}:epic_conflict:audit-${entry!.id}`])
    expect((await epicInboxItems(t.db)).map(i => i.subject)).toEqual(['Conflicted'])

    const [session] = await t.db.insert(planSessions).values({ projectId: project.id, title: 'Reply', createdBy: t.actor, unread: true }).returning()
    await t.db.insert(planMessages).values({ sessionId: session!.id, role: 'pm', text: 'Done' })
    const [quiet] = await t.db.insert(planSessions).values({ projectId: project.id, title: 'Quiet', createdBy: t.actor, unread: true }).returning()
    await t.db.insert(planMessages).values({ sessionId: quiet!.id, role: 'human', text: 'Hello' })
    const task = await t.createTask(project.slug)
    await setStatus(task.id, 'human_review')

    const listed = await loadInbox(t.db)
    expect(listed.needsYou.some(i => i.type === 'plan_thread' && i.subject === 'Quiet')).toBe(false)
    expect(listed.needsYou.some(i => i.type === 'plan_thread' && i.subject === 'Reply')).toBe(false)
    expect(listed.needsYou.some(i => i.type === 'epic_conflict')).toBe(true)
    expect(listed.count).toBe(listed.needsYou.length)
    await t.db.update(epics).set({ reviewState: 'merged' }).where(eq(epics.id, conflict!.id))
    await t.db.update(tasks).set({ status: 'merged', statusReason: null }).where(eq(tasks.id, task.id))
  })

  it('links an epic\'s activity to its first task', async () => {
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, title: 'Linked', description: '', createdBy: t.actor }).returning()
    const first = await t.createTask(project.slug, { epicId: epic!.id })
    const second = await t.createTask(project.slug, { epicId: epic!.id })
    // Rewriting the first row moves it behind the second in the heap
    await t.db.update(tasks).set({ title: 'Moved' }).where(eq(tasks.id, first.id))
    await appendAudit(t.db, { projectId: project.id, actor: system }, auditEvent('epic.pr', { epicId: epic!.id, event: 'opened', prNumber: 1 }))
    const item = (await inbox()).activity.find(i => i.epicId === epic!.id)
    expect(second.number).toBeGreaterThan(first.number)
    expect(item?.taskId).toBe(first.id)
  })

  it('publishes an epic without its tasks', async () => {
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, title: 'Light', description: '', createdBy: t.actor }).returning()
    await t.createTask(project.slug, { epicId: epic!.id })
    expect(await loadEpic(t.db, epic!.id)).not.toHaveProperty('tasks')
    const res = await t.request('PATCH', `/api/epics/${epic!.id}`, { title: 'Lighter' })
    expect(await res.json()).toMatchObject({ title: 'Lighter', taskCount: 0 })
  })

  it('answers 404 for a malformed ID in a URL', async () => {
    for (const path of ['/api/runs/nope', '/api/runs/nope/transcript', '/api/evidence/nope/file', '/api/plan/sessions/nope', '/api/runs?agentId=nope']) {
      expect((await t.request('GET', path)).status, path).toBe(404)
    }
    expect((await t.request('POST', '/api/inbox/nope/actions', { action: 'send_back' })).status).toBe(404)
  })

  it('leaves no unaudited agent behind', async () => {
    await expect(createAgent(t.db, { name: 'Unaudited', role: 'developer', runtime: 'claude-code' } as never, undefined as never)).rejects.toThrow()
    expect(await t.db.select().from(agents).where(eq(agents.name, 'Unaudited'))).toEqual([])
  })
})

describe('concurrent task writes on postgres', () => {
  let t: TestApp
  let project: Project
  databaseFixture('postgres', async () => {
    t = await createTestApp('postgres')
    project = await t.createProject({ repository: 'cormacrw/concurrent' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
  })
  afterAll(async () => {
    await t?.close()
  })

  const held = () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return { gate, release }
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 150))

  it('blocks a dependent from its row as it stands after a concurrent write', async ({ skip }) => {
    requireDatabase('postgres', { skip })
    const dependency = await t.createTask(project.slug)
    const dependent = await t.createTask(project.slug, { dependsOn: [dependency.number] })
    await t.db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, dependent.id))
    const { gate, release } = held()
    const writer = t.db.transaction(async (tx) => {
      await tx.update(tasks).set({ failedRuns: 2 }).where(eq(tasks.id, dependent.id))
      await gate
    })
    await settle()
    const deleted = deleteTaskRows(t.db, dependency.id, t.actor, null)
    await settle()
    release()
    await Promise.all([writer, deleted])
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, dependent.id))
    expect(row).toMatchObject({ status: 'blocked', failedRuns: 2 })
  })

  it('never lets two opposite dependency edits both commit', async ({ skip }) => {
    requireDatabase('postgres', { skip })
    for (let i = 0; i < 6; i++) {
      const [a, b] = [await t.createTask(project.slug), await t.createTask(project.slug)] as [Task, Task]
      const patch = (task: Task, on: Task) => t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { dependsOn: [on.number] })
      const statuses = (await Promise.all([patch(a, b), patch(b, a)])).map(r => r.status).sort()
      expect(statuses).toEqual([200, 400])
    }
  }, 60_000)

  it('doesn\'t deadlock a dependency edit with a transaction auditing the same task', async ({ skip }) => {
    requireDatabase('postgres', { skip })
    const [a, b] = [await t.createTask(project.slug), await t.createTask(project.slug)] as [Task, Task]
    const { gate, release } = held()
    const holder = t.db.transaction(async (tx) => {
      await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, a.id)).for('update')
      await gate
      await appendAudit(tx, { projectId: project.id, taskId: a.id, actor: system }, auditEvent('task.updated', { changed: [] }))
    })
    await settle()
    const patched = t.request('PATCH', `/api/projects/${project.slug}/tasks/${a.number}`, { dependsOn: [b.number] })
    await settle()
    release()
    await holder
    expect((await patched).status).toBe(200)
  })
})
