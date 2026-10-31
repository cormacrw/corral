import { packBundle } from '@corral/core'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

describe('approval notes', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    runner = await FakeRunner.connect(t.server!.url, [], 'notes', { slots: 50 })
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  async function reviewTask(type: 'task' | 'bug' | 'spike' | 'design') {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { type })
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    if (type === 'design') {
      const bundleBlob = await t.blobs.put(packBundle([{ path: 'index.html', data: new TextEncoder().encode('<p>Design</p>') }]))
      const specBlob = await t.blobs.put(new TextEncoder().encode('# Design'))
      await t.db.insert(schema.designVersions).values({ taskId: task.id, version: 1, bundleBlob, specBlob, branch: 'design/T-1', commitSha: 'a'.repeat(40) })
    }
    return { task, comments: `/api/projects/${project.slug}/tasks/${task.number}/comments`, version: `/api/projects/${project.slug}/tasks/${task.number}/designs/1/approve` }
  }

  it.each(['task', 'bug', 'spike'] as const)('saves a trimmed human note when approving a %s through the Inbox', async (type) => {
    const { task, comments } = await reviewTask(type)
    expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'approve', text: '  Looks good.  ' })).status).toBe(200)
    expect(await t.request('GET', comments).then(r => r.json())).toEqual([
      expect.objectContaining({ body: 'Looks good.', author: t.actor, pinned: false })
    ])
    // A repeated approval is rejected and cannot append another comment.
    expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'approve', text: 'Rejected note' })).status).toBe(409)
    expect(await t.request('GET', comments).then(r => r.json())).toHaveLength(1)
  })

  it.each(['inbox', 'panel'] as const)('saves design notes from %s on the task and in the PM build session', async (route) => {
    const { task, comments, version } = await reviewTask('design')
    const res = await t.request('POST', route === 'inbox' ? `/api/inbox/${task.id}/actions` : version,
      route === 'inbox' ? { action: 'approve', text: '  Build this design.  ' } : { note: '  Build this design.  ' })
    expect(res.status).toBe(200)
    expect(await t.request('GET', comments).then(r => r.json())).toEqual([
      expect.objectContaining({ body: 'Build this design.', author: t.actor, pinned: false })
    ])
    const [design] = await t.db.select().from(schema.designVersions).where(eq(schema.designVersions.taskId, task.id))
    const [message] = await t.db.select().from(schema.planMessages).where(eq(schema.planMessages.sessionId, design!.planSessionId!))
    expect(message!.text).toContain('Build this design.')
    expect(message!.role).toBe('human')
    // Retrying a completed version is idempotent.
    expect((await t.request('POST', version, { note: 'Retry note' })).status).toBe(200)
    expect(await t.request('GET', comments).then(r => r.json())).toHaveLength(1)
  })

  it.each(['task', 'design'] as const)('does not comment for empty, whitespace or absent notes on a %s', async (type) => {
    for (const text of ['', ' \n\t ', undefined]) {
      const { task, comments } = await reviewTask(type)
      expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'approve', text })).status).toBe(200)
      expect(await t.request('GET', comments).then(r => r.json())).toEqual([])
    }
  })

  it.each(['task', 'design'] as const)('keeps requested changes as exactly one pinned comment on a %s', async (type) => {
    const { task, comments } = await reviewTask(type)
    expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'request_changes', text: 'Please revise the controls.' })).status).toBe(200)
    expect(await t.request('GET', comments).then(r => r.json())).toEqual([
      expect.objectContaining({ body: 'Please revise the controls.', author: t.actor, pinned: true })
    ])
  })

  it('leaves no note on a design when no runner is available through either route', async () => {
    runner.close()
    await expect.poll(() => t.runner.online).toBe(false)
    for (const route of ['inbox', 'panel']) {
      const { task, comments, version } = await reviewTask('design')
      const res = await t.request('POST', route === 'inbox' ? `/api/inbox/${task.id}/actions` : version,
        route === 'inbox' ? { action: 'approve', text: 'Cannot approve' } : { note: 'Cannot approve' })
      expect(res.status).toBe(503)
      expect(await t.request('GET', comments).then(r => r.json())).toEqual([])
      expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]!.status).toBe('human_review')
      expect((await t.db.select().from(schema.designVersions).where(eq(schema.designVersions.taskId, task.id)))[0]!.status).toBe('submitted')
    }
  })
})
