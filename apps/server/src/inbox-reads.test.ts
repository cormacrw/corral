import type { Inbox, InboxItem } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const { auditLog, tasks } = schema

// Every Inbox item is unread until the human opens it, like email
describe('inbox read state', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp('pglite')
  })

  afterAll(async () => {
    await t?.close()
  })

  const inbox = async () => t.request('GET', '/api/inbox').then(r => r.json()) as Promise<Inbox>
  const read = (item: Pick<InboxItem, 'type' | 'id'>) => t.request('POST', '/api/inbox/read', { type: item.type, id: item.id })
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)

  it('shows task and activity items unread until opened, and unread again when the task arrives anew', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { title: 'Read me' })
    await t.db.update(tasks).set({ status: 'human_review' }).where(eq(tasks.id, task.id))
    await t.db.insert(auditLog).values([
      { projectId: project.id, taskId: task.id, actor: t.actor, action: 'task.transition', detail: { event: 'pr_opened', from: 'in_progress', to: 'in_review' }, createdAt: ago(20) },
      { projectId: project.id, taskId: task.id, actor: t.actor, action: 'task.transition', detail: { event: 'review_approved', from: 'in_review', to: 'human_review' }, createdAt: ago(10) }
    ])
    const before = await inbox()
    const review = before.needsYou.find(i => i.id === task.id)!
    const activity = before.activity.find(i => i.taskId === task.id)!
    expect(review).toMatchObject({ type: 'human_review', unread: true })
    expect(activity).toMatchObject({ type: 'activity', unread: true })

    const seen = t.events.length
    expect((await read(review)).status).toBe(200)
    expect(t.events.slice(seen)).toContainEqual({ type: 'inbox.read', itemType: 'human_review', id: task.id })
    const after = await inbox()
    expect(after.needsYou.find(i => i.id === task.id)).toMatchObject({ unread: false })
    // Reading one item leaves the rest alone
    expect(after.activity.find(i => i.id === activity.id)).toMatchObject({ unread: true })
    expect(after.count).toBe(before.count)

    // Back in Human review after the read: a new arrival, unread again
    await t.db.insert(auditLog).values({ projectId: project.id, taskId: task.id, actor: t.actor, action: 'task.transition', detail: { event: 'review_approved', from: 'in_review', to: 'human_review' }, createdAt: new Date(Date.now() + 1000) })
    expect((await inbox()).needsYou.find(i => i.id === task.id)).toMatchObject({ unread: true })
  })

  it('refuses plan threads and release notes, which have their own read routes', async () => {
    expect((await t.request('POST', '/api/inbox/read', { type: 'plan_thread', id: 'x' })).status).toBe(400)
    expect((await t.request('POST', '/api/inbox/read', { type: 'release_notes', id: 'x' })).status).toBe(400)
  })

  it('lists Resolved items as read', async () => {
    expect((await inbox()).resolved.every(i => !i.unread)).toBe(true)
  })
})
