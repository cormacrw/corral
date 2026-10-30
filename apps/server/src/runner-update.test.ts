import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { type RunnerInfo } from '@corral/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

describe('runner updates', () => {
  let t: TestApp
  const peers: FakeRunner[] = []
  afterEach(async () => {
    peers.splice(0).forEach(r => r.close())
    await t?.close()
  })
  async function connect(id: string, options: Parameters<typeof FakeRunner.connect>[3] = {}) {
    const peer = await FakeRunner.connect(t.server!.url, [], id, options)
    peers.push(peer)
    return peer
  }
  async function status() {
    return (await (await t.request('GET', '/api/status')).json() as { runners: RunnerInfo[] }).runners
  }

  it('reports both commits, drains without stopping a live run, routes work elsewhere, and clears on updated restart', async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(schema.agents).set({ concurrency: 10 }).where(eq(schema.agents.role, 'developer'))
    const a = await connect('A', { commit: 'old', slots: 1 })
    expect(await status()).toContainEqual(expect.objectContaining({ id: 'A', commit: 'old', serverCommit: 'development', behind: true, draining: false }))
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const first = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${first.number}/transitions`, { type: 'approve' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: false })
    await t.orchestrator.schedule()
    const job = (await a.next('run.assign')).job
    a.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'session' })
    const response = await t.request('POST', '/api/runners/A/update')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ draining: true, updateRequested: true })
    expect(await a.next('runner.drain')).toMatchObject({ updateRequested: true })
    expect(a.received.some(m => m.type === 'run.stop')).toBe(false)
    expect(t.runner.available()).toEqual([])
    // In-flight placement cannot send into a runner after drain either.
    expect(t.runner.send({ type: 'run.assign', job }, 'A')).toBe(false)
    const b = await connect('B')
    expect(t.runner.pick()).toBe('B')
    const second = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${second.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    expect((await b.next('run.assign')).job.taskId).toBe(second.id)
    expect(await a.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', summary: 'Which copy should I use?' })).toMatchObject({ ok: true })
    a.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'stopped' }, headSha: null })
    await sleep(100)
    expect(a.received.some(m => m.type === 'run.assign')).toBe(false)
    a.close()
    await vi.waitFor(() => expect(t.runner.isOnline('A')).toBe(false))
    await connect('A')
    expect(await status()).toContainEqual(expect.objectContaining({ id: 'A', online: true, behind: false, draining: false, updateRequested: false }))
    expect(t.runner.available().map(r => r.id)).toContain('A')
  }, 60000)

  it('only automatically drains behind runners that opted in, retaining setup fallback', async () => {
    t = await createTestApp('pglite', { listen: true })
    await connect('auto', { commit: 'old', autoUpdate: true })
    expect(await status()).toContainEqual(expect.objectContaining({ id: 'auto', behind: true, draining: true, updateRequested: false }))
    expect(t.runner.available()).toEqual([])
    expect(t.runner.pick()).toBe('auto')
    expect((await t.runner.detectClis()).kind).toBe('detect_clis')
    await connect('manual', { commit: 'old' })
    expect(t.runner.available().map(r => r.id)).toEqual(['manual'])
    expect(t.runner.pick()).toBe('manual')
    await t.request('POST', '/api/runners/manual/update')
    expect(t.runner.pick()).not.toBeNull()
    expect((await t.request('POST', '/api/runners/missing/update')).status).toBe(503)
  }, 60000)
})
