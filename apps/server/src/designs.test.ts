import type { DesignVersion, Inbox } from '@corral/contracts'
import { packBundle } from '@corral/core'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleContentType, DESIGN_BUNDLE_CSP } from './designs.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

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

// The design view's API (D20): list versions, their screenshots, approve one
describe('design versions in the task view', () => {
  let t: TestApp
  let runner: FakeRunner

  // Approving opens a Plan session, whose PM turn needs the runner
  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    runner = await FakeRunner.connect(t.server!.url, [], 'r1', { slots: 50 })
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  async function designTask(versions: number) {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { type: 'design' })
    const bundleBlob = await t.blobs.put(packBundle([{ path: 'index.html', data: text('<p>hi</p>') }]))
    for (let v = 1; v <= versions; v++) {
      const specBlob = await t.blobs.put(text(`# Design v${v}`))
      const shot = await t.blobs.put(text(`png v${v}`))
      await t.db.insert(schema.designVersions).values({
        taskId: task.id, version: v, status: v < versions ? 'changes_requested' : 'submitted', bundleBlob, specBlob,
        screenshots: [{ blob: shot, fileName: 'login.png', contentType: 'image/png' }], branch: 'design/T-1', commitSha: String(v).repeat(40)
      })
    }
    return { project, task }
  }

  it('lists versions newest first with their spec, screenshots and preview', async () => {
    const { project, task } = await designTask(2)
    const res = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/designs`)
    expect(res.status).toBe(200)
    const list = await res.json() as DesignVersion[]
    expect(list.map(v => [v.version, v.status, v.spec])).toEqual([[2, 'submitted', '# Design v2'], [1, 'changes_requested', '# Design v1']])
    expect(list[0]!.previewUrl).toBe(`/api/designs/${list[0]!.id}/files/`)
    const shot = await t.request('GET', list[0]!.screenshots[0]!.url)
    expect(shot.status).toBe(200)
    expect(shot.headers.get('content-type')).toBe('image/png')
    expect(shot.headers.get('content-security-policy')).toBe(DESIGN_BUNDLE_CSP)
    expect(await shot.text()).toBe('png v2')
    expect((await t.request('GET', `/api/designs/${list[0]!.id}/screenshots/5`)).status).toBe(404)
  })

  it('approves a version in Human review and supersedes the earlier ones', async () => {
    const { project, task } = await designTask(2)
    const path = `/api/projects/${project.slug}/tasks/${task.number}/designs/2/approve`
    expect((await t.request('POST', path)).status).toBe(409)

    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    const approved = await t.request('POST', path)
    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({ status: 'approved' })
    const list = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/designs`).then(r => r.json()) as DesignVersion[]
    expect(list.map(v => [v.version, v.status])).toEqual([[2, 'approved'], [1, 'superseded']])

    const taskPath = `/api/projects/${project.slug}/tasks/${task.number}`
    const patched = await t.request('PATCH', taskPath, { type: 'task' })
    expect(patched.status).toBe(409)
    expect(await patched.json()).toMatchObject({ error: { code: 'conflict', constraint: 'task_type_locked' } })
    expect(await t.request('GET', taskPath).then(r => r.json())).toMatchObject({ type: 'design', status: 'approved' })
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.resolved.find(i => i.taskId === task.id)?.resolution).toBe('You approved the design')
    expect(inbox.activity.find(i => i.taskId === task.id)?.preview).toBe('You approved the design')
    const reopened = await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'request_changes', text: 'Please make the controls larger.' })
    expect(reopened.status).toBe(200)
    expect(await reopened.json()).toMatchObject({ task: { type: 'design', status: 'in_progress' } })

    // A superseded version can't be approved
    const again = await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/designs/1/approve`)
    expect(again.status).toBe(409)
  })

  it('rejects changing a task awaiting merge into a design without changing its status', async () => {
    const { project, task } = await designTask(0)
    await t.db.update(schema.tasks).set({ type: 'task', status: 'ready_to_merge' }).where(eq(schema.tasks.id, task.id))
    const path = `/api/projects/${project.slug}/tasks/${task.number}`
    const res = await t.request('PATCH', path, { type: 'design' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'conflict', constraint: 'task_type_locked' } })
    expect(await t.request('GET', path).then(r => r.json())).toMatchObject({ type: 'task', status: 'ready_to_merge' })
  })

  it.each(['human_review', 'ready_to_merge'] as const)('approves the latest submitted version from the Inbox in %s and wakes the PM', async (status) => {
    const { project, task } = await designTask(5)
    await t.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, task.id))
    const res = await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'approve' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ task: { status: 'approved' } })
    const list = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/designs`).then(r => r.json()) as DesignVersion[]
    expect(list.map(v => [v.version, v.status])).toEqual([[5, 'approved'], [4, 'superseded'], [3, 'superseded'], [2, 'superseded'], [1, 'superseded']])
    const [session] = await t.db.select().from(schema.planSessions).where(eq(schema.planSessions.id, list[0]!.planSessionId!))
    const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.planSessionId, session!.id))
    expect(run).toMatchObject({ role: 'pm' })
    expect((await runner.next('run.assign', m => m.job.planSessionId === session!.id)).job).toMatchObject({ role: 'pm', projectId: project.id })
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as { needsYou: { taskId?: string }[] }
    expect(inbox.needsYou.some(item => item.taskId === task.id)).toBe(false)
  })

  it('recovers a stuck design through its version endpoint and never inspects its PR in the merge pass', async () => {
    const { project, task } = await designTask(5)
    // Even a legacy design with PR metadata must be left alone.
    await t.db.update(schema.tasks).set({ status: 'ready_to_merge', prNumber: 999, prUrl: 'https://github.com/cormacrw/test-app/pull/999', headSha: 'design-head' }).where(eq(schema.tasks.id, task.id))
    const calls = t.github.calls.length
    await t.orchestrator.merges.tick()
    expect(t.github.calls.slice(calls)).toEqual([])
    const before = await t.request('GET', `/api/tasks/${task.ref}`).then(r => r.json())
    expect(before).toMatchObject({ status: 'ready_to_merge' })
    const res = await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/designs/5/approve`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'approved' })
  })

  it.each(['inbox', 'version'] as const)('recovers a legacy approved version without a build session through %s', async (route) => {
    const { project, task } = await designTask(1)
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    await t.db.update(schema.designVersions).set({ status: 'approved' }).where(eq(schema.designVersions.taskId, task.id))
    const path = route === 'inbox' ? `/api/inbox/${task.id}/actions` : `/api/projects/${project.slug}/tasks/${task.number}/designs/1/approve`
    expect((await t.request('POST', path, route === 'inbox' ? { action: 'approve' } : {})).status).toBe(200)
    expect(await t.request('GET', `/api/tasks/${task.ref}`).then(r => r.json())).toMatchObject({ status: 'approved' })
    const [version] = await t.db.select().from(schema.designVersions).where(eq(schema.designVersions.taskId, task.id))
    expect(version).toMatchObject({ status: 'approved', planSessionId: expect.any(String) })
    expect((await runner.next('run.assign', m => m.job.planSessionId === version!.planSessionId)).job.role).toBe('pm')
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as { needsYou: { taskId?: string }[] }
    expect(inbox.needsYou.some(item => item.taskId === task.id)).toBe(false)
  })

  it.each(['human_review', 'ready_to_merge'] as const)('reuses a legacy approved version’s build session from both approval routes in %s', async (status) => {
    for (const route of ['inbox', 'version']) {
      const { project, task } = await designTask(1)
      await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
      const versionPath = `/api/projects/${project.slug}/tasks/${task.number}/designs/1/approve`
      expect((await t.request('POST', versionPath)).status).toBe(200)
      const [before] = await t.db.select().from(schema.designVersions).where(eq(schema.designVersions.taskId, task.id))
      await t.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, task.id))
      expect((await t.request('POST', route === 'inbox' ? `/api/inbox/${task.id}/actions` : versionPath, route === 'inbox' ? { action: 'approve' } : {})).status).toBe(200)
      expect(await t.request('GET', `/api/tasks/${task.ref}`).then(r => r.json())).toMatchObject({ status: 'approved' })
      const [after] = await t.db.select().from(schema.designVersions).where(eq(schema.designVersions.taskId, task.id))
      expect(after!.planSessionId).toBe(before!.planSessionId)
      expect(await t.db.select().from(schema.planMessages).where(eq(schema.planMessages.sessionId, before!.planSessionId!))).toHaveLength(1)
      expect(await t.db.select().from(schema.runs).where(eq(schema.runs.planSessionId, before!.planSessionId!))).toHaveLength(1)
    }
  })

  it('does not recover an older approval over a newer submitted version', async () => {
    const { project, task } = await designTask(2)
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    const versions = await t.db.select().from(schema.designVersions).where(eq(schema.designVersions.taskId, task.id)).orderBy(schema.designVersions.version)
    await t.db.update(schema.designVersions).set({ status: 'approved' }).where(eq(schema.designVersions.id, versions[0]!.id))
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/designs/1/approve`)).status).toBe(409)
    expect(await t.request('GET', `/api/tasks/${task.ref}`).then(r => r.json())).toMatchObject({ status: 'human_review' })
    expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'approve' })).status).toBe(200)
    expect((await t.db.select().from(schema.designVersions).where(eq(schema.designVersions.id, versions[1]!.id)))[0]).toMatchObject({ status: 'approved' })
  })

  it('rejects generic human_approve transitions without changing the task or version', async () => {
    const { project, task } = await designTask(1)
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'human_approve' })).status).toBe(400)
    await expect(t.orchestrator.merges.humanApprove(task.id, t.actor)).rejects.toMatchObject({ status: 409 })
    const after = await t.request('GET', `/api/tasks/${task.ref}`).then(r => r.json())
    expect(after).toMatchObject({ status: 'human_review' })
    expect((await t.db.select().from(schema.designVersions).where(eq(schema.designVersions.taskId, task.id)))[0]).toMatchObject({ status: 'submitted' })
  })

  it('leaves approval untouched when the PM is paused', async () => {
    const { task } = await designTask(1)
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    await t.db.update(schema.agents).set({ paused: true }).where(eq(schema.agents.role, 'pm'))
    try {
      const res = await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'approve' })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: { constraint: 'pm_paused' } })
      expect(await t.request('GET', `/api/tasks/${task.ref}`).then(r => r.json())).toMatchObject({ status: 'human_review' })
      expect((await t.db.select().from(schema.designVersions).where(eq(schema.designVersions.taskId, task.id)))[0]).toMatchObject({ status: 'submitted', planSessionId: null })
    } finally {
      await t.db.update(schema.agents).set({ paused: false }).where(eq(schema.agents.role, 'pm'))
    }
  })

  it('does not approve a design through the Inbox if no version is submitted', async () => {
    const { task } = await designTask(1)
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    await t.db.update(schema.designVersions).set({ status: 'changes_requested' }).where(eq(schema.designVersions.taskId, task.id))
    expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'approve' })).status).toBe(409)
    expect(await t.request('GET', `/api/tasks/${task.ref}`).then(r => r.json())).toMatchObject({ status: 'human_review' })
  })

  it('refuses to approve a version of a task that is not a design', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/designs/1/approve`)).status).toBe(409)
  })
})
