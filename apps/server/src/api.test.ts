import type { Attachment, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { asc, eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

describe.each(['pglite', 'postgres'] as const)('HTTP API on %s', (driver) => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp(driver)
  })

  afterAll(async () => {
    await t?.close()
  })

  async function transition(slug: string, number: number, body: unknown) {
    return t.request('POST', `/api/projects/${slug}/tasks/${number}/transitions`, body)
  }

  it('reports health', async () => {
    const res = await t.request('GET', '/api/health')
    expect(await res.json()).toEqual({ ok: true })
  })

  describe('profile name', () => {
    it('stores the trimmed name and returns it from GET /me', async () => {
      const res = await t.request('PATCH', '/api/me', { name: '  Cormac  ' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ name: 'Cormac' })
      expect(await t.request('GET', '/api/me').then(r => r.json())).toMatchObject({ name: 'Cormac' })
      expect(t.events.some(e => e.type === 'profile.updated' && e.profile.name === 'Cormac')).toBe(true)
    })

    it('rejects an empty name or one over 80 characters', async () => {
      for (const name of ['', '   ', 'x'.repeat(81)]) {
        const res = await t.request('PATCH', '/api/me', { name })
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
      }
      expect((await t.request('PATCH', '/api/me', { name: 'x'.repeat(80) })).status).toBe(200)
      expect((await t.request('PATCH', '/api/me', {})).status).toBe(400)
    })
  })

  describe('profile pictures', () => {
    // A 1×1 PNG
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))

    it('stores, serves and removes the human\'s picture', async () => {
      expect(await t.request('GET', '/api/me').then(r => r.json())).toMatchObject({ avatarUrl: null })
      const saved = await t.request('PUT', '/api/me/avatar', new Blob([png], { type: 'image/png' }))
      expect(saved.status).toBe(200)
      const { avatarUrl } = await saved.json() as { avatarUrl: string }
      expect(avatarUrl).toMatch(/^\/api\/me\/avatar\?v=[0-9a-f]{12}$/)
      const served = await t.request('GET', avatarUrl)
      expect(served.headers.get('content-type')).toBe('image/png')
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(png)
      expect(t.events.some(e => e.type === 'profile.updated' && e.profile.avatarUrl === avatarUrl)).toBe(true)
      expect(await t.request('DELETE', '/api/me/avatar').then(r => r.json())).toMatchObject({ avatarUrl: null })
      expect((await t.request('GET', '/api/me/avatar')).status).toBe(404)
    })

    it('stores an agent\'s picture and shows it on the agent', async () => {
      const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
      const saved = await t.request('PUT', `/api/agents/${agent!.id}/avatar`, new Blob([png], { type: 'image/png' }))
      expect(await saved.json()).toMatchObject({ id: agent!.id, avatarUrl: expect.stringMatching(new RegExp(`^/api/agents/${agent!.id}/avatar\\?v=`)) })
      const listed = await t.request('GET', '/api/agents').then(r => r.json()) as { id: string, avatarUrl: string | null }[]
      expect(listed.find(a => a.id === agent!.id)?.avatarUrl).toBeTruthy()
      expect(t.events.some(e => e.type === 'agent.updated' && e.agent.id === agent!.id && e.agent.avatarUrl !== null)).toBe(true)
      expect((await t.request('PUT', '/api/agents/not-an-id/avatar', new Blob([png], { type: 'image/png' }))).status).toBe(404)
    })

    it('rejects files that aren\'t the image they claim to be', async () => {
      const text = await t.request('PUT', '/api/me/avatar', new Blob(['hello'], { type: 'text/plain' }))
      expect(text.status).toBe(400)
      const fake = await t.request('PUT', '/api/me/avatar', new Blob(['<svg/>'], { type: 'image/png' }))
      expect(fake.status).toBe(400)
      expect(await fake.json()).toMatchObject({ error: { code: 'invalid_input', issues: [{ message: 'The file isn\'t a PNG image' }] } })
      const huge = await t.request('PUT', '/api/me/avatar', new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'image/png' }))
      expect(huge.status).toBe(413)
    })
  })

  describe('attachments', () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
    const jpeg = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0xFF, 0xD9])
    const gif = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
    const webp = Uint8Array.from(Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'))
    const upload = (slug: string, data: string | Uint8Array<ArrayBuffer>, type: string, query = '') =>
      t.request('POST', `/api/projects/${slug}/attachments${query}`, new Blob([data], { type }))

    it('stores each image type and serves the same bytes back', async () => {
      const project = await t.createProject()
      for (const [type, data] of [['image/png', png], ['image/jpeg', jpeg], ['image/gif', gif], ['image/webp', webp]] as const) {
        const res = await upload(project.slug, data, type, '?name=screens%2Fshot.img')
        expect(res.status).toBe(201)
        const body = await res.json() as Attachment
        expect(body).toEqual({ id: expect.any(String), mimeType: type, fileName: 'shot.img', byteSize: data.byteLength, url: `/api/attachments/${body.id}/file` })
        const served = await t.request('GET', body.url)
        expect(served.status).toBe(200)
        expect(served.headers.get('content-type')).toBe(type)
        expect(served.headers.get('x-content-type-options')).toBe('nosniff')
        expect(served.headers.get('cache-control')).toContain('immutable')
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(data)
      }
      const unnamed = await upload(project.slug, png, 'image/png; charset=binary').then(r => r.json()) as Attachment
      expect(unnamed).toMatchObject({ fileName: 'image.png', mimeType: 'image/png' })
    })

    it('rejects SVG, non-images, mislabelled files and files over 10 MB', async () => {
      const project = await t.createProject()
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
      for (const [data, type] of [[svg, 'image/svg+xml'], [svg, 'image/png'], ['hello', 'text/plain'], [png, 'application/octet-stream'], [jpeg, 'image/png'], [new Uint8Array(0), 'image/png']] as const) {
        const res = await upload(project.slug, data, type)
        expect(res.status, `${type}`).toBe(400)
        expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
      }
      const huge = new Uint8Array(10 * 1024 * 1024 + 1)
      huge.set(png)
      expect((await upload(project.slug, huge, 'image/png')).status).toBe(413)
      expect(await t.db.select().from(schema.attachments).where(eq(schema.attachments.projectId, project.id))).toEqual([])
    })

    it('stores the same bytes once but keeps a row per upload', async () => {
      const project = await t.createProject()
      // Bytes no other test has stored
      const image = Uint8Array.from([...gif, ...randomBytes(8)])
      const blobsBefore = t.blobs.size
      const first = await upload(project.slug, image, 'image/gif', '?name=a.gif').then(r => r.json()) as Attachment
      const second = await upload(project.slug, image, 'image/gif', '?name=b.gif').then(r => r.json()) as Attachment
      expect(first.id).not.toBe(second.id)
      const rows = await t.db.select().from(schema.attachments).where(eq(schema.attachments.projectId, project.id))
      expect(rows).toHaveLength(2)
      expect(rows[0]!.blob).toBe(rows[1]!.blob)
      expect(rows[0]!.createdBy).toEqual(t.actor)
      expect(t.blobs.size).toBe(blobsBefore + 1)
      expect(await t.blobs.get(rows[0]!.blob)).toEqual(image)
    })

    it('returns 404 for unknown projects and attachments', async () => {
      expect((await upload('no-such-project', png, 'image/png')).status).toBe(404)
      expect((await t.request('GET', '/api/attachments/not-an-id/file')).status).toBe(404)
      expect((await t.request('GET', '/api/attachments/00000000-0000-4000-8000-000000000000/file')).status).toBe(404)
    })

    it('removes a project\'s attachments with the project', async () => {
      const project = await t.createProject({ name: 'Short lived' })
      const kept = await t.createProject()
      const doomed = await upload(project.slug, png, 'image/png').then(r => r.json()) as Attachment
      const other = await upload(kept.slug, png, 'image/png').then(r => r.json()) as Attachment
      expect((await t.request('DELETE', `/api/projects/${project.slug}`, { confirm: 'Short lived' })).status).toBe(204)
      expect(await t.db.select().from(schema.attachments).where(eq(schema.attachments.projectId, project.id))).toEqual([])
      expect((await t.request('GET', doomed.url)).status).toBe(404)
      expect((await t.request('GET', other.url)).status).toBe(200)
    })
  })

  describe('projects', () => {
    it('creates a project with a slug from its name', async () => {
      const project = await t.createProject({ name: 'Corral Web', prefix: 'CW' })
      expect(project).toMatchObject({ name: 'Corral Web', slug: 'corral-web', prefix: 'CW', mergeMethod: 'squash' })
      const res = await t.request('GET', '/api/projects/corral-web')
      expect(await res.json()).toEqual(project)
    })

    it('lets only one project use a repository (D13)', async () => {
      await t.createProject({ repository: 'owner/taken' })
      const res = await t.request('POST', '/api/projects', {
        name: 'Again', prefix: 'AGN', repository: 'owner/taken', defaultBranch: 'main'
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: { code: 'conflict', constraint: 'projects_repository_unique' } })
    })

    it('rejects a bad prefix', async () => {
      const res = await t.request('POST', '/api/projects', {
        name: 'Bad', prefix: 'toolong', repository: 'owner/bad', defaultBranch: 'main'
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_input')
    })

    it('returns 404 for an unknown project', async () => {
      expect((await t.request('GET', '/api/projects/nope')).status).toBe(404)
    })
  })

  describe('tasks', () => {
    it('numbers tasks per project and starts them in Backlog', async () => {
      const project = await t.createProject({ prefix: 'NUM' })
      const first = await t.createTask(project.slug)
      const second = await t.createTask(project.slug, { dependsOn: [1] })
      expect(first).toMatchObject({ ref: 'NUM-1', status: 'backlog', lease: null, dependsOn: [] })
      expect(second).toMatchObject({ ref: 'NUM-2', dependsOn: ['NUM-1'] })
      expect(second.acceptanceCriteria.map(c => c.text)).toEqual(['Shows an error on a bad password'])
    })

    it('takes the human-review default from the project (D5)', async () => {
      const project = await t.createProject({ humanReviewDefault: true })
      expect((await t.createTask(project.slug)).humanReview).toBe(true)
      expect((await t.createTask(project.slug, { humanReview: false })).humanReview).toBe(false)
    })

    it('rejects a dependency on a task that does not exist', async () => {
      const project = await t.createProject({ prefix: 'DEP' })
      const res = await t.request('POST', `/api/projects/${project.slug}/tasks`, { title: 'X', type: 'backend', dependsOn: [7] })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'invalid_dependencies', problems: [{ code: 'unknown_dependency', dependsOn: 'DEP-7' }] }
      })
    })

    it('splits the board from the backlog (D10)', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      await t.createTask(project.slug)
      await transition(project.slug, 2, { type: 'approve' })

      const list = async (view: string) =>
        ((await (await t.request('GET', `/api/projects/${project.slug}/tasks?view=${view}`)).json()) as Task[]).map(x => x.number)
      expect(await list('board')).toEqual([2])
      expect(await list('backlog')).toEqual([1])
      expect(await list('all')).toEqual([1, 2])
    })
  })

  describe('transitions', () => {
    it('approves a task that meets the Definition of Ready', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      const res = await transition(project.slug, 1, { type: 'approve' })
      expect(res.status).toBe(200)
      expect(((await res.json()) as Task).status).toBe('ready')
    })

    it('explains why a task is not ready', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug, { description: null, acceptanceCriteria: [] })
      const res = await transition(project.slug, 1, { type: 'approve' })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: { code: 'transition_rejected', reason: { code: 'not_ready', problems: ['missing_description', 'missing_acceptance_criteria'] } }
      })
    })

    it('rejects a transition D10 does not allow from the current status', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      const res = await transition(project.slug, 1, { type: 'send_back' })
      expect(await res.json()).toEqual({
        error: { code: 'transition_rejected', reason: { code: 'invalid_transition', status: 'backlog', event: 'send_back' } }
      })
    })

    it('accepts only the transitions a human may ask for', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      const res = await transition(project.slug, 1, { type: 'claim' })
      expect(res.status).toBe(400)
    })

    it('records who did it in the audit log (D1)', async () => {
      const project = await t.createProject()
      const task = await t.createTask(project.slug)
      await transition(project.slug, 1, { type: 'approve' })
      await transition(project.slug, 1, { type: 'send_back' })

      const entries = await t.db.select().from(schema.auditLog)
        .where(eq(schema.auditLog.taskId, task.id))
        .orderBy(asc(schema.auditLog.id))
      expect(entries.map(e => [e.action, e.actor, e.detail])).toEqual([
        ['task.created', t.actor, { number: 1 }],
        ['task.transition', t.actor, { event: { type: 'approve' }, from: 'backlog', to: 'ready' }],
        ['task.transition', t.actor, { event: { type: 'send_back' }, from: 'ready', to: 'backlog' }]
      ])
    })

    it('publishes the updated task for live updates', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      t.events.length = 0
      await transition(project.slug, 1, { type: 'approve' })
      expect(t.events).toMatchObject([{ type: 'task.updated', task: { number: 1, status: 'ready' } }])
    })
  })
})
