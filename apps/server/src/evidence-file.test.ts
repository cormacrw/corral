import { schema } from '@corral/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { byteRange } from './byte-range.ts'
import { createTestApp, type TestApp } from './test-app.ts'

describe('evidence file byte ranges', () => {
  let t: TestApp
  let app: ReturnType<typeof createApp>
  let path: string
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

  it('rejects every valid range on an empty file', () => {
    for (const header of ['bytes=0-0', 'bytes=0-', 'bytes=-1']) {
      expect(byteRange(header, 0)).toBe('unsatisfiable')
    }
  })
})
