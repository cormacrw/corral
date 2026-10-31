import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EpicReviewItem, Inbox, TaskInboxItem } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const { agents, comments, designVersions, epics, evidence, projects, runs, tasks } = schema

// What changed since the human last acted (design/inbox.md), through the real
// API. Run rows are inserted, because no agent works here: `earlier` is before
// any action a test takes and `later` after it.
describe('inbox changes since the last review', () => {
  let t: TestApp
  let project: Awaited<ReturnType<TestApp['createProject']>>
  let run: string
  const earlier = new Date(Date.now() - 60_000)
  const later = new Date(Date.now() + 60_000)
  const developer = { kind: 'agent', role: 'developer', runId: 'run' } as const

  beforeAll(async () => {
    t = await createTestApp('pglite')
    project = await t.createProject()
    await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
    const [agent] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
    const host = await t.createTask(project.slug, { title: 'Run host' })
    const [row] = await t.db.insert(runs).values({ agentId: agent!.id, projectId: project.id, taskId: host.id, role: 'developer', state: 'completed', endedAt: earlier }).returning()
    run = row!.id
  })

  afterAll(async () => {
    await t?.close()
  })

  const inbox = async () => t.request('GET', '/api/inbox').then(r => r.json()) as Promise<Inbox>
  const taskItem = async (id: string) => (await inbox()).needsYou.find(i => i.id === id) as TaskInboxItem
  const act = (id: string, body: unknown) => t.request('POST', `/api/inbox/${id}/actions`, body)
  const capture = async (name: string, data: unknown) => {
    if (process.env.CORRAL_INBOX_EVIDENCE_DIR) await writeFile(join(process.env.CORRAL_INBOX_EVIDENCE_DIR, name), JSON.stringify(data, null, 2))
  }
  const file = (taskId: string, fileName: string, createdAt: Date, round = 0) =>
    t.db.insert(evidence).values({ taskId, runId: run, round, kind: 'screenshot', fileName, blob: 'sha', contentType: 'image/png', size: 1, createdAt })
  const note = (taskId: string, createdAt: Date) =>
    t.db.insert(evidence).values({ taskId, runId: run, round: 0, kind: 'note', note: 'Checked by reading it', size: 0, createdAt })
  const task = async (title: string, set: Partial<typeof tasks.$inferInsert> = { status: 'human_review' }) => {
    const created = await t.createTask(project.slug, { title })
    await t.db.update(tasks).set(set).where(eq(tasks.id, created.id))
    return created
  }
  const names = (item: { newArtifacts?: { name: string }[] }) => item.newArtifacts?.map(a => a.name)

  it('has no since on a first review, and lists every file but no written note', async () => {
    const { id } = await task('First review')
    await file(id, 'one.png', earlier)
    await file(id, 'two.png', later)
    await note(id, later)

    const item = await taskItem(id)
    await capture('first-review.json', { request: 'GET /api/inbox', item })
    expect(item.since).toBeNull()
    expect(names(item)).toEqual(['two.png', 'one.png'])
    expect(item.newArtifacts![0]).toMatchObject({ kind: 'screenshot', url: expect.stringMatching(/^\/api\/evidence\/.+\/file$/), taskRef: null })
  })

  it('carries the feedback and the notes after it, and only files attached after it', async () => {
    const { id } = await task('Changes requested')
    await file(id, 'before.png', earlier)
    await t.db.insert(comments).values({ taskId: id, author: developer, body: 'First attempt', createdAt: earlier })
    expect((await act(id, { action: 'request_changes', text: 'Make the button bigger' })).status).toBe(200)

    await t.db.update(tasks).set({ status: 'human_review' }).where(eq(tasks.id, id))
    await file(id, 'after.png', later)
    await note(id, later)
    await t.db.insert(comments).values([
      { taskId: id, author: developer, body: 'Made the button bigger', createdAt: later },
      { taskId: id, author: developer, body: '## Findings\n\nNot a work note', createdAt: later },
      { taskId: id, author: { kind: 'agent', role: 'reviewer', runId: 'run' }, body: 'A reviewer comment', createdAt: later }
    ])

    const item = await taskItem(id)
    await capture('changes-requested.json', { request: 'POST /api/inbox/:id/actions', body: { action: 'request_changes', text: 'Make the button bigger' }, inboxItem: item })
    expect(item.since).toMatchObject({ text: 'Make the button bigger', notes: [{ text: 'Made the button bigger', taskRef: null }], fixTasks: [] })
    expect(item.since!.at < later.toISOString()).toBe(true)
    expect(names(item)).toEqual(['after.png'])
  })

  it('lists the new design version and its preview link, not the earlier one', async () => {
    const { id } = await task('Design', { status: 'human_review', type: 'design' })
    const version = (n: number, createdAt: Date) => t.db.insert(designVersions).values({ taskId: id, version: n, bundleBlob: 'b', specBlob: 's', branch: 'design/x', commitSha: 'a'.repeat(40), createdAt }).returning()
    const [first] = await version(1, earlier)
    expect(await taskItem(id)).toMatchObject({ since: null, newArtifacts: [{ kind: 'design', name: 'Design v1', url: `/api/designs/${first!.id}/files/` }] })

    expect((await act(id, { action: 'request_changes', text: 'Larger controls' })).status).toBe(200)
    await t.db.update(tasks).set({ status: 'human_review' }).where(eq(tasks.id, id))
    expect((await taskItem(id)).newArtifacts).toEqual([])
    const [second] = await version(2, later)

    const item = await taskItem(id)
    await capture('design.json', { firstVersionPreview: `/api/designs/${first!.id}/files/`, inboxItem: item })
    expect(item.since).toMatchObject({ text: 'Larger controls' })
    expect(item.newArtifacts).toEqual([{ id: second!.id, kind: 'design', name: 'Design v2', url: `/api/designs/${second!.id}/files/`, taskRef: null, at: later.toISOString() }])
  })

  it('compares by time when resolving resets the review rounds, and carries the answer', async () => {
    const { id } = await task('Reset rounds', { status: 'blocked', statusReason: 'Round cap', reviewRounds: 3 })
    await file(id, 'round-3.png', earlier, 3)
    await file(id, 'round-0-before.png', earlier, 0)
    expect((await act(id, { action: 'clarify', text: 'Use the v2 API' })).status).toBe(200)
    expect((await t.db.select().from(tasks).where(eq(tasks.id, id)))[0]!.reviewRounds).toBe(0)

    await t.db.update(tasks).set({ status: 'human_review' }).where(eq(tasks.id, id))
    await file(id, 'round-0-after.png', later, 0)

    const item = await taskItem(id)
    await capture('rounds-reset.json', { request: 'POST /api/inbox/:id/actions', body: { action: 'clarify', text: 'Use the v2 API' }, inboxItem: item })
    expect(item.since).toMatchObject({ text: 'Use the v2 API' })
    expect(names(item)).toEqual(['round-0-after.png'])
  })

  it('has no words for a resolve without any, even with an older pinned comment', async () => {
    const { id } = await task('Retried', { status: 'blocked', statusReason: 'Stuck' })
    await t.db.insert(comments).values({ taskId: id, author: t.actor, body: 'From an earlier answer', pinned: true, createdAt: earlier })
    expect((await act(id, { action: 'clarify', text: 'Try again' })).status).toBe(200)
    await t.db.update(tasks).set({ status: 'failed', statusReason: 'Gave up' }).where(eq(tasks.id, id))
    await t.request('POST', `/api/projects/${project.slug}/tasks/${(await t.db.select().from(tasks).where(eq(tasks.id, id)))[0]!.number}/transitions`, { type: 'resolve', to: 'in_progress' })
    await t.db.update(tasks).set({ status: 'human_review' }).where(eq(tasks.id, id))
    expect((await taskItem(id)).since).toMatchObject({ text: null })
  })

  it('carries an epic\'s feedback and fix tasks, and labels new files with their task', async () => {
    const branch = `corral/epic-${project.id}`
    t.github.setBranch(project.repository, branch, 'head-1')
    const pr = await t.github.openPullRequest(project.repository, { head: branch, base: project.defaultBranch, title: 'Search', body: '' })
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, createdBy: t.actor, title: 'Search', reviewMode: 'epic', branch, prNumber: pr.number, prHeadSha: 'head-1', reviewState: 'human_review' }).returning()
    const member = await task('Search API', { status: 'merged', epicId: epic!.id })
    await t.db.insert(runs).values({ agentId: (await t.db.select().from(agents).where(eq(agents.role, 'reviewer')))[0]!.id, projectId: project.id, epicId: epic!.id, role: 'reviewer', state: 'completed', outcome: 'approved', summary: 'Fine', endedAt: earlier })
    await file(member.id, 'api-before.png', earlier)
    await note(member.id, later)

    const epicItem = async () => (await inbox()).needsYou.find(i => i.id === epic!.id) as EpicReviewItem
    const first = await epicItem()
    expect(first.since).toBeNull()
    expect(first.newArtifacts).toMatchObject([{ name: 'api-before.png', taskRef: member.ref }])

    const body = { action: 'request_changes', headSha: 'head-1', text: 'The empty state is wrong' }
    expect((await t.request('POST', `/api/epics/${epic!.id}/review`, body)).status).toBe(200)
    const [fix] = await t.db.select().from(tasks).where(eq(tasks.epicId, epic!.id)).then(rows => rows.filter(r => r.title.startsWith('Fix integration:')))
    await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, fix!.id))
    await t.db.update(epics).set({ reviewState: 'human_review' }).where(eq(epics.id, epic!.id))
    await file(fix!.id, 'fix-after.png', later)
    await t.db.insert(comments).values({ taskId: fix!.id, author: developer, body: 'Fixed the empty state', createdAt: later })

    const item = await epicItem()
    const ref = `${project.prefix}-${fix!.number}`
    await capture('epic.json', { request: `POST /api/epics/:id/review`, body, inboxItem: { ...item, tasks: undefined } })
    expect(item.since).toMatchObject({ text: 'The empty state is wrong', notes: [{ text: 'Fixed the empty state', taskRef: ref }], fixTasks: [{ id: fix!.id, ref, title: fix!.title }] })
    expect(item.newArtifacts).toMatchObject([{ name: 'fix-after.png', taskRef: ref, kind: 'screenshot' }])
    expect(item.newArtifacts).toHaveLength(1)
  })
})
