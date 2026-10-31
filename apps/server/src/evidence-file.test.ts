import { schema } from '@corral/db'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { LocalBlobStore } from './blob-store.ts'
import { byteRange } from './byte-range.ts'
import { createTestApp, type TestApp } from './test-app.ts'

describe('evidence file byte ranges', () => {
  let t: TestApp
  let app: ReturnType<typeof createApp>
  let path: string
  let attach: (fileName: string, contentType: string) => Promise<string>
  const data = Uint8Array.from({ length: 256 }, (_, i) => i)

  beforeAll(async () => {
    t = await createTestApp('pglite')
    app = createApp({ ...t, events: t.bus })
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const task = await t.createTask(project.slug)
    const [agent] = await t.db.select().from(schema.agents)
    const [run] = await t.db.insert(schema.runs).values({ projectId: project.id, taskId: task.id, agentId: agent!.id, role: 'developer' }).returning()
    const [file] = await t.db.insert(schema.evidence).values({
      taskId: task.id, runId: run!.id, round: 0, kind: 'video',
      blob: await t.blobs.put(data), size: data.length, fileName: 'clip.mp4', contentType: 'video/mp4'
    }).returning()
    path = `/api/evidence/${file!.id}/file`
    attach = async (fileName, contentType) => {
      const [row] = await t.db.insert(schema.evidence).values({
        taskId: task.id, runId: run!.id, round: 0, kind: 'other',
        blob: await t.blobs.put(data), size: data.length, fileName, contentType
      }).returning()
      return `/api/evidence/${row!.id}/file`
    }
  })

  afterAll(async () => {
    await t?.close()
  })

  it.each([
    [undefined, 200, 0, 255],
    ['bytes=0-1', 206, 0, 1],
    ['bytes=100-', 206, 100, 255],
    ['bytes=-100', 206, 156, 255],
    ['bytes=250-99999999999999999999999', 206, 250, 255],
    ['bytes=-99999999999999999999999', 206, 0, 255],
    ['bytes=0-0', 206, 0, 0],
    ['bytes=256-', 416, null, null],
    ['bytes=99999999999999999999999-', 416, null, null],
    ['bytes=20-10', 416, null, null],
    ['bytes=-0', 416, null, null],
    ['bytes=-', 200, 0, 255],
    ['bytes=0-1,4-5', 200, 0, 255],
    ['items=0-1', 200, 0, 255],
    ['bytes=foo-bar', 200, 0, 255]
  ] as const)('serves %s with status %s', async (range, status, start, end) => {
    const res = await app.request(path, { headers: range ? { range } : {} })
    expect(res.status).toBe(status)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(res.headers.get('content-disposition')).toBe('inline; filename="clip.mp4"')
    const expected = start === null ? new Uint8Array() : data.slice(start, end! + 1)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(expected)
    expect(res.headers.get('content-length')).toBe(String(expected.length))
    expect(res.headers.get('content-range')).toBe(status === 206 ? `bytes ${start}-${end}/256` : status === 416 ? 'bytes */256' : null)
  })

  it('reads only the bytes asked for', async () => {
    const whole = vi.spyOn(t.blobs, 'get')
    const res = await app.request(path, { headers: { range: 'bytes=0-1' } })
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.slice(0, 2))
    expect(whole).not.toHaveBeenCalled()
    whole.mockRestore()
  })

  it.each([
    ['report.html', 'text/html', 'attachment; filename="report.html"', 'text/html'],
    ['page.xhtml', 'application/xhtml+xml', 'attachment; filename="page.xhtml"', 'application/xhtml+xml'],
    ['logo.svg', 'image/svg+xml', 'attachment; filename="logo.svg"', 'image/svg+xml'],
    ['odd', 'text/html\r\nx-injected: 1', 'attachment; filename="odd"', 'application/octet-stream'],
    ['shot.png', 'IMAGE/PNG', 'inline; filename="shot.png"', 'image/png'],
    ['run.log', 'text/plain; charset=latin1', 'inline; filename="run.log"', 'text/plain; charset=utf-8']
  ])('serves %s (%s) safely', async (fileName, contentType, disposition, type) => {
    const res = await app.request(await attach(fileName, contentType))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(disposition)
    expect(res.headers.get('content-type')).toBe(type)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  it('keeps a PDF inline and unsandboxed for the viewer\'s iframe', async () => {
    const res = await app.request(await attach('report.pdf', 'application/pdf'))
    expect(res.headers.get('content-disposition')).toBe('inline; filename="report.pdf"')
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it.each([
    ['résumé "1".png', 'inline; filename="r_sum_ 1.png"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%201.png'],
    ['two\nlines.png', 'inline; filename="twolines.png"'],
    ['日本語.png', 'inline; filename="___.png"; filename*=UTF-8\'\'%E6%97%A5%E6%9C%AC%E8%AA%9E.png']
  ])('sends the name %j in a header', async (fileName, disposition) => {
    const res = await app.request(await attach(fileName, 'image/png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(disposition)
  })

  it('streams a range over a real socket', async () => {
    const served = await createTestApp('pglite', { listen: true })
    try {
      const project = await served.createProject({ repository: 'cormacrw/socket' })
      await served.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
      const task = await served.createTask(project.slug)
      const [agent] = await served.db.select().from(schema.agents)
      const [run] = await served.db.insert(schema.runs).values({ projectId: project.id, taskId: task.id, agentId: agent!.id, role: 'developer' }).returning()
      const [file] = await served.db.insert(schema.evidence).values({
        taskId: task.id, runId: run!.id, round: 0, kind: 'video',
        blob: await served.blobs.put(data), size: data.length, fileName: 'clip.mp4', contentType: 'video/mp4'
      }).returning()
      const res = await fetch(`${served.server!.url}/api/evidence/${file!.id}/file`, { headers: { range: 'bytes=10-19' } })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-length')).toBe('10')
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.slice(10, 20))
    } finally {
      await served.close()
    }
  }, 30_000)

  it('rejects every valid range on an empty file', () => {
    for (const header of ['bytes=0-0', 'bytes=0-', 'bytes=-1']) {
      expect(byteRange(header, 0)).toBe('unsatisfiable')
    }
  })
})

describe('LocalBlobStore.open', () => {
  it('streams a range of a blob, and knows the size without reading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corral-blobs-'))
    try {
      const store = new LocalBlobStore(root)
      const data = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251)
      const blob = await store.open(await store.put(data))
      expect(blob?.size).toBe(data.length)
      expect(new Uint8Array(await new Response(blob!.stream(70_000, 139_999)).arrayBuffer())).toEqual(data.slice(70_000, 140_000))
      expect(new Uint8Array(await new Response(blob!.stream()).arrayBuffer())).toEqual(data)
      expect(await store.open('0'.repeat(64))).toBeNull()
      expect(await store.open('../escape')).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
