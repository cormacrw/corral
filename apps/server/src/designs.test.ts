import { packBundle } from '@corral/core'
import { schema } from '@corral/db'
import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleContentType, DESIGN_BUNDLE_CSP } from './designs.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const text = (s: string) => new TextEncoder().encode(s)

// GET /designs/:versionId/files/* over a real socket, so paths reach the
// server exactly as sent (fetch would normalise `..` away first)
describe('design bundle files', () => {
  let t: TestApp
  let versionId: string

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { type: 'design' })
    const bundleBlob = await t.blobs.put(packBundle([
      { path: 'index.html', data: text('<!doctype html><script src="./assets/app.js"></script>') },
      { path: 'assets/app.js', data: text('console.log(1)') },
      { path: 'assets/app.css', data: text('body{}') },
      { path: 'assets/logo.svg', data: text('<svg xmlns="http://www.w3.org/2000/svg"/>') },
      { path: 'screens/index.html', data: text('<p>screens</p>') },
      { path: 'data.bin', data: new Uint8Array([1, 2, 3]) }
    ]))
    const specBlob = await t.blobs.put(text('# Design'))
    const [version] = await t.db.insert(schema.designVersions).values({
      taskId: task.id, version: 1, bundleBlob, specBlob, branch: 'design/T-1', commitSha: 'a'.repeat(40)
    }).returning()
    versionId = version!.id
  })

  afterAll(async () => {
    await t?.close()
  })

  // A raw GET: the path goes on the request line untouched
  function get(path: string): Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: string }> {
    const url = new URL(t.server!.url)
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path, method: 'GET' }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  const files = () => `/api/designs/${versionId}/files`

  it('serves each file with its content type and the sandbox headers', async () => {
    const cases: [string, string, string][] = [
      ['/index.html', 'text/html; charset=utf-8', '<!doctype html>'],
      ['/', 'text/html; charset=utf-8', '<!doctype html>'],
      ['/assets/app.js', 'text/javascript; charset=utf-8', 'console.log(1)'],
      ['/assets/app.css', 'text/css; charset=utf-8', 'body{}'],
      ['/assets/logo.svg', 'image/svg+xml', '<svg'],
      ['/screens/', 'text/html; charset=utf-8', '<p>screens</p>'],
      ['/data.bin', 'application/octet-stream', '\u0001']
    ]
    for (const [path, type, start] of cases) {
      const res = await get(`${files()}${path}`)
      expect(res.status, path).toBe(200)
      expect(res.headers['content-type'], path).toBe(type)
      expect(res.body.startsWith(start), path).toBe(true)
      expect(res.headers['content-security-policy'], path).toBe(DESIGN_BUNDLE_CSP)
      expect(res.headers['x-content-type-options'], path).toBe('nosniff')
    }
    expect(DESIGN_BUNDLE_CSP).toMatch(/^sandbox allow-scripts;/)
    expect(DESIGN_BUNDLE_CSP).not.toContain('allow-same-origin')
    expect(DESIGN_BUNDLE_CSP).toContain('connect-src \'none\'')
  })

  it('redirects the bare folder to its trailing slash, so relative paths resolve inside it', async () => {
    const res = await get(files())
    expect(res.status).toBe(301)
    expect(res.headers.location).toBe(`${files()}/`)
  })

  it('rejects `..`, absolute paths and their encoded forms', async () => {
    const bad = [
      '/../index.html',
      '/assets/../index.html',
      '/assets/../../../../etc/passwd',
      '/%2e%2e/index.html',
      '/assets/%2E%2E/index.html',
      '/..%2findex.html',
      '/assets%2f..%2f..%2fsecret',
      '//etc/passwd',
      '/%2fetc/passwd',
      '/C:/Windows/win.ini',
      '/..%5cindex.html',
      '/./index.html',
      '/a%00b',
      '/../../../health',
      '/%zz'
    ]
    for (const path of bad) {
      const res = await get(`${files()}${path}`)
      expect(res.status, path).toBe(400)
      expect(JSON.parse(res.body), path).toMatchObject({ error: { code: 'invalid_input' } })
      expect(res.headers['content-security-policy'], path).toBeUndefined()
    }
  })

  it('returns 404 for missing files and versions', async () => {
    expect((await get(`${files()}/nope.js`)).status).toBe(404)
    expect((await get('/api/designs/00000000-0000-4000-8000-000000000000/files/index.html')).status).toBe(404)
    expect((await get('/api/designs/not-an-id/files/index.html')).status).toBe(404)
  })
})

describe('bundleContentType', () => {
  it('maps extensions case-insensitively and falls back to octet-stream', () => {
    expect(bundleContentType('a/B.JS')).toBe('text/javascript; charset=utf-8')
    expect(bundleContentType('font.woff2')).toBe('font/woff2')
    expect(bundleContentType('Makefile')).toBe('application/octet-stream')
    expect(bundleContentType('x.unknown')).toBe('application/octet-stream')
  })
})
