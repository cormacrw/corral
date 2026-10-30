import { needsAttention, type Inbox, type Deployment } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const sha = (c: string) => c.repeat(40)

describe.each(['pglite', 'postgres'] as const)('POST /api/deployments on %s', (driver) => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp(driver)
  })

  afterAll(async () => {
    await t?.close()
  })

  it('records a deploy for the project with that repository, with its commits', async () => {
    const project = await t.createProject()
    const commits = [{ sha: sha('c'), subject: 'Second change' }, { sha: sha('b'), subject: 'First change' }]
    const res = await t.request('POST', '/api/deployments', { repository: project.repository.toUpperCase(), fromSha: sha('a'), toSha: sha('c'), commits })
    expect(res.status).toBe(201)
    const deployment = await res.json() as Deployment
    expect(deployment).toMatchObject({ projectId: project.id, fromSha: sha('a'), toSha: sha('c'), commits, notes: null, notesStatus: 'pending', readAt: null })
    const rows = await t.db.select().from(schema.deployments).where(eq(schema.deployments.projectId, project.id))
    expect(rows).toHaveLength(1)
  })

  it('lists release notes in the Inbox, keeps reading separate from dismissal and streams updates', async () => {
    const project = await t.createProject()
    const getInbox = async () => (await (await t.request('GET', '/api/inbox')).json()) as Inbox
    const before = await getInbox()
    const created = await t.request('POST', '/api/deployments', { repository: project.repository, fromSha: sha('1'), toSha: sha('2'), commits: [] })
    const deployment = await created.json() as Deployment
    const pending = await getInbox()
    const item = pending.needsYou.find(i => i.id === deployment.id)!
    expect(item).toMatchObject({ type: 'release_notes', fromSha: '1111111', toSha: '2222222', notesStatus: 'pending', unread: true, sender: { role: 'pm' }, project: { id: project.id } })
    expect(needsAttention(item)).toBe(false)
    expect(pending.count).toBe(before.count)
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'deployment.updated', deployment: expect.objectContaining({ id: deployment.id }) }))
    const read = await t.request('POST', `/api/deployments/${deployment.id}/read`)
    expect(read.status).toBe(200)
    const readAt = (await read.json() as Deployment).readAt
    expect(readAt).toBeTruthy()
    expect((await getInbox()).needsYou.find(i => i.id === deployment.id)).toMatchObject({ unread: false })
    const again = await t.request('POST', `/api/deployments/${deployment.id}/read`)
    expect((await again.json() as Deployment).readAt).toBe(readAt)
    expect((await t.request('POST', `/api/deployments/${deployment.id}/dismiss`)).status).toBe(200)
    const dismissed = await getInbox()
    expect(dismissed.needsYou.some(i => i.id === deployment.id)).toBe(false)
    expect(dismissed.resolved.find(i => i.id === deployment.id)).toMatchObject({ type: 'release_notes', unread: false, resolution: 'You dismissed these release notes' })
    expect(dismissed.count).toBe(before.count)
    expect((await t.request('POST', '/api/deployments/00000000-0000-0000-0000-000000000000/read')).status).toBe(404)
  })

  it('returns the existing record when the same toSha is posted again', async () => {
    const project = await t.createProject()
    const body = { repository: project.repository, fromSha: null, toSha: sha('d'), commits: [{ sha: sha('d'), subject: 'Only change' }] }
    const first = await t.request('POST', '/api/deployments', body)
    expect(first.status).toBe(201)
    const again = await t.request('POST', '/api/deployments', { ...body, commits: [] })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(await first.json())
    const rows = await t.db.select().from(schema.deployments).where(eq(schema.deployments.projectId, project.id))
    expect(rows).toHaveLength(1)
  })

  it('keeps every commit of a long range', async () => {
    const project = await t.createProject()
    const commits = Array.from({ length: 1001 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0'), subject: `Change ${i}` }))
    const res = await t.request('POST', '/api/deployments', { repository: project.repository, fromSha: sha('a'), toSha: commits[0]!.sha, commits })
    expect(res.status).toBe(201)
    const [row] = await t.db.select().from(schema.deployments).where(eq(schema.deployments.projectId, project.id))
    expect(row!.commits).toEqual(commits)
  })

  it('keeps the same toSha apart per project', async () => {
    const one = await t.createProject()
    const two = await t.createProject()
    for (const project of [one, two]) {
      const res = await t.request('POST', '/api/deployments', { repository: project.repository, fromSha: null, toSha: sha('e'), commits: [] })
      expect(res.status).toBe(201)
    }
  })

  it('lists only the latest 20 deployments by date, including first-deploy and fallback notes', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, task.id))
    const rows = await t.db.insert(schema.deployments).values(Array.from({ length: 22 }, (_, i) => ({
      projectId: project.id, fromSha: null, toSha: i.toString(16).padStart(40, '0'),
      notes: 'Fallback notes', notesStatus: 'failed' as const, createdAt: new Date(Date.now() + (i + 1) * 1000)
    }))).returning()
    const inbox = await (await t.request('GET', '/api/inbox')).json() as Inbox
    const notes = inbox.needsYou.filter(i => i.type === 'release_notes')
    expect(notes.map(i => i.deploymentId)).toEqual(rows.slice(-20).reverse().map(r => r.id))
    expect(notes[0]).toMatchObject({ fromSha: null, notesStatus: 'failed', notes: 'Fallback notes' })
    expect(inbox.count).toBe(inbox.needsYou.length - 20)
  })

  it('places release notes among attention items by deployment time, read or unread', async () => {
    // The suite shares a database, and only the latest 20 deployments are listed
    await t.db.delete(schema.deployments)
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, task.id))
    const getInbox = async () => (await (await t.request('GET', '/api/inbox')).json()) as Inbox
    const before = await getInbox()
    const at = Date.parse(before.needsYou.find(i => i.taskId === task.id)!.at)
    const deployment = (minutes: number, toSha: string) => ({ projectId: project.id, fromSha: null, toSha, notes: 'Notes', notesStatus: 'ready' as const, createdAt: new Date(at + minutes * 60_000) })
    const [older, newer] = await t.db.insert(schema.deployments).values([deployment(-1, sha('1')), deployment(1, sha('2'))]).returning()
    const ids = async () => (await getInbox()).needsYou.filter(i => i.project.id === project.id).map(i => i.id)
    const expected = [newer!.id, task.id, older!.id]
    expect(await ids()).toEqual(expected)
    expect((await t.request('POST', `/api/deployments/${older!.id}/read`)).status).toBe(200)
    expect((await t.request('POST', `/api/deployments/${newer!.id}/read`)).status).toBe(200)
    expect(await ids()).toEqual(expected)
    expect((await getInbox()).count).toBe(before.count)
  })

  it('404s for a repository no project uses and rejects bad input', async () => {
    const missing = await t.request('POST', '/api/deployments', { repository: 'nobody/nothing', fromSha: null, toSha: sha('f'), commits: [] })
    expect(missing.status).toBe(404)
    const project = await t.createProject()
    for (const body of [
      { repository: project.repository, fromSha: null, toSha: 'main', commits: [] },
      { repository: project.repository, toSha: sha('f'), commits: [] },
      { repository: project.repository, fromSha: null, toSha: sha('f'), commits: [{ sha: 'abc' }] }
    ]) {
      expect((await t.request('POST', '/api/deployments', body)).status).toBe(400)
    }
  })
})
