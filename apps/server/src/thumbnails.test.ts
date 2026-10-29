import type { Inbox, Project } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

describe.each(['pglite', 'postgres'] as const)('project thumbnails on %s', (driver) => {
  let t: TestApp
  let project: Project
  beforeAll(async () => {
    t = await createTestApp(driver)
    project = await t.createProject({ repository: 'cormacrw/test-app' })
  })
  afterAll(async () => {
    await t?.close()
  })
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const upload = (data: Uint8Array, type: string, slug = project.slug) => {
    const body = new FormData()
    body.set('file', new File([new Uint8Array(data)], 'image', { type }))
    return t.request('PUT', `/api/projects/${slug}/thumbnail`, body)
  }

  it('stores all supported types, versions replacements and broadcasts each change', async () => {
    let previous: string | null = null
    for (const [type, data] of [
      ['image/png', png], ['image/jpeg', Uint8Array.from([255, 216, 255])],
      ['image/webp', new TextEncoder().encode('RIFF1234WEBP')], ['image/gif', new TextEncoder().encode('GIF89a')]
    ] as const) {
      const response = await upload(data, type)
      expect(response.status).toBe(200)
      const saved = await response.json() as Project
      expect(saved.thumbnailUrl).toBeTruthy()
      expect(saved.thumbnailUrl).not.toBe(previous)
      if (previous) expect((await t.request('GET', previous)).status).toBe(404)
      previous = saved.thumbnailUrl
      const served = await t.request('GET', saved.thumbnailUrl!)
      expect(served.headers.get('content-type')).toBe(type)
      expect(served.headers.get('cache-control')).toContain('no-cache')
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(data)
      expect(t.events.at(-1)).toMatchObject({ type: 'project.updated', project: { thumbnailUrl: saved.thumbnailUrl } })
    }
  })

  it('accepts a file at the cap with multipart overhead and rejects missing or malformed files', async () => {
    const data = new Uint8Array(2 * 1024 * 1024)
    data.set(png)
    expect((await upload(data, 'image/png')).status).toBe(200)
    expect((await t.request('PUT', `/api/projects/${project.slug}/thumbnail`, new FormData())).status).toBe(400)
    expect((await t.request('PUT', `/api/projects/${project.slug}/thumbnail`, {})).status).toBe(400)
  })

  it('rejects invalid uploads without changing the project', async () => {
    const before = await t.request('GET', `/api/projects/${project.slug}`).then(r => r.json())
    for (const [data, type, status, message] of [
      [png, 'text/plain', 400, 'Use a PNG'], [png, 'image/jpeg', 400, 'isn\'t a JPEG'],
      [new Uint8Array(), 'image/png', 400, 'empty'],
      [new Uint8Array(2 * 1024 * 1024 + 1), 'image/png', 413, 'over 2 MB'],
      [new Uint8Array(3 * 1024 * 1024), 'image/png', 413, 'over 2 MB']
    ] as const) {
      const response = await upload(data, type)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_input', issues: [{ path: ['file'], message: expect.stringContaining(message) }] } })
      expect(await t.request('GET', `/api/projects/${project.slug}`).then(r => r.json())).toEqual(before)
    }
    expect((await upload(png, 'image/png', 'unknown-project')).status).toBe(404)
  })

  it('includes the URL in inbox summaries and removes the image without changing colour', async () => {
    await t.request('PATCH', `/api/projects/${project.slug}`, { thumbnailColor: '#123456' })
    const saved = await upload(png, 'image/png').then(r => r.json()) as Project
    const task = await t.createTask(project.slug)
    await t.db.update(schema.tasks).set({ status: 'blocked' }).where(eq(schema.tasks.id, task.id))
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.needsYou.some(item => item.project.thumbnailUrl === saved.thumbnailUrl)).toBe(true)
    const removed = await t.request('DELETE', `/api/projects/${project.slug}/thumbnail`)
    expect(await removed.json()).toMatchObject({ thumbnailUrl: null, thumbnailColor: '#123456' })
    expect((await t.request('GET', saved.thumbnailUrl!)).status).toBe(404)
    expect(t.events.at(-1)).toMatchObject({ type: 'project.updated', project: { thumbnailUrl: null } })
  })
})
