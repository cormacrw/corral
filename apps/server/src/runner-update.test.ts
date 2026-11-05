import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { RUNNER_UPDATE_GRACE_MS } from '@corral/contracts/client'
import { RUNNER_PROTOCOL_VERSION, type Inbox, type RunnerInfo } from '@corral/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runnerUpdateItems } from './inbox.ts'
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
    expect(await a.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', note: 'Need a decision on copy', summary: 'Which copy should I use?' })).toMatchObject({ ok: true })
    a.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'stopped' }, headSha: null })
    await sleep(100)
    expect(a.received.some(m => m.type === 'run.assign')).toBe(false)
    a.close()
    await vi.waitFor(() => expect(t.runner.isOnline('A')).toBe(false), { timeout: 5000 })
    await connect('A')
    expect(await status()).toContainEqual(expect.objectContaining({ id: 'A', online: true, behind: false, draining: false, updateRequested: false }))
    expect(t.runner.available().map(r => r.id)).toContain('A')
  }, 60000)

  async function readyTask() {
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const task = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: false })
    return task
  }
  const needsYou = async () => (await (await t.request('GET', '/api/inbox')).json() as Inbox).needsYou.filter(i => i.type === 'runner_update')

  it('gives no run to a runner whose agent tools differ, drains it for the host updater with auto-update off, and takes it back once updated', async () => {
    t = await createTestApp('pglite', { listen: true })
    const old = await connect('gaming-pc', { commit: 'old', toolContract: 'old-tools', autoUpdate: false })
    expect(await status()).toContainEqual(expect.objectContaining({ id: 'gaming-pc', behind: true, draining: true, toolContractReason: expect.stringContaining('(old-tools)') }))
    const task = await readyTask()
    await t.orchestrator.schedule()
    await sleep(100)
    expect(old.received.some(m => m.type === 'run.assign')).toBe(false)

    old.close()
    await vi.waitFor(() => expect(t.runner.isOnline('gaming-pc')).toBe(false), { timeout: 5000 })
    const updated = await connect('gaming-pc')
    await t.orchestrator.schedule()
    expect((await updated.next('run.assign')).job.taskId).toBe(task.id)
    expect(await status()).toContainEqual(expect.objectContaining({ id: 'gaming-pc', behind: false, draining: false, toolContractReason: null }))
  }, 60000)

  it('treats a runner from before tool contracts as different', async () => {
    t = await createTestApp('pglite', { listen: true })
    await connect('legacy', { commit: 'old', toolContract: undefined })
    expect(await status()).toContainEqual(expect.objectContaining({ id: 'legacy', draining: true, toolContractReason: expect.stringContaining('before tool contracts') }))
  }, 60000)

  it('keeps a failed update out of placement when its tools differ, and shows the error in Needs you until it updates', async () => {
    t = await createTestApp('pglite', { listen: true })
    const old = await connect('gaming-pc', { commit: 'old', toolContract: 'old-tools' })
    await readyTask()
    expect(await needsYou()).toEqual([])
    old.send({ type: 'runner.update-status', draining: false, updateRequested: false, activeRunCount: 0, updateState: 'failed', updateError: 'Runner image build failed; inspect journalctl -u corral-runner-update' })
    await vi.waitFor(async () => expect(await needsYou()).toMatchObject([{ id: 'runner-gaming-pc', subject: 'gaming-pc can\'t update', body: expect.stringContaining('image build failed'), commit: 'old', serverCommit: 'development', online: true, project: null }]), { timeout: 5000 })
    const inbox = await (await t.request('GET', '/api/inbox')).json() as Inbox
    expect(inbox.count).toBe(inbox.needsYou.length)
    expect(await status()).toContainEqual(expect.objectContaining({ id: 'gaming-pc', draining: false }))
    await t.orchestrator.schedule()
    await sleep(100)
    expect(old.received.some(m => m.type === 'run.assign')).toBe(false)

    old.close()
    await vi.waitFor(() => expect(t.runner.isOnline('gaming-pc')).toBe(false), { timeout: 5000 })
    // Still behind while it's offline
    expect(await needsYou()).toMatchObject([{ online: false }])
    await connect('gaming-pc')
    expect(await needsYou()).toEqual([])
  }, 60000)

  it('reports any behind runner whose update failed, and one with differing tools that nothing is updating', async () => {
    t = await createTestApp('pglite', { listen: true })
    await connect('behind', { commit: 'old', autoUpdate: true })
    const failed = await connect('failed', { commit: 'old', autoUpdate: true })
    await connect('stalled', { commit: 'old', toolContract: 'old-tools' })
    failed.send({ type: 'runner.update-status', draining: false, updateRequested: false, activeRunCount: 0, updateState: 'failed', updateError: 'Build failed' })
    await vi.waitFor(async () => expect((await needsYou()).map(i => i.id)).toEqual(['runner-failed']), { timeout: 5000 })
    const later = Date.now() + RUNNER_UPDATE_GRACE_MS + 1000
    expect(runnerUpdateItems(await status(), later).map(i => i.id).sort()).toEqual(['runner-failed', 'runner-stalled'])
    expect(runnerUpdateItems(await status(), later).find(i => i.id === 'runner-stalled')!.body).toContain('No update attempt')
  }, 60000)

  it('reports a runner refused at the protocol check with no update attempt, timed from its first refusal', async () => {
    t = await createTestApp('pglite', { listen: true })
    const refuse = (updateState = '') => t.runner.connect({ send: () => {}, close: () => {} }).onMessage(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION - 1, commit: 'old', runnerId: 'M', name: 'old-mini', activeRuns: [], updateState }))
    await refuse()
    expect(await needsYou()).toEqual([])
    const first = (await status()).find(r => r.id === 'M')!.connectedAt
    await sleep(5)
    await refuse()
    const refused = (await status()).find(r => r.id === 'M')!
    expect(refused).toMatchObject({ needsUpdate: true, online: false, connectedAt: first })
    const later = Date.now() + RUNNER_UPDATE_GRACE_MS + 1000
    expect(runnerUpdateItems([refused], later)).toMatchObject([{ id: 'runner-M', online: false, body: expect.stringContaining('refuses its protocol version') }])
    // An update under way is what the wait is for
    await refuse('building')
    expect(runnerUpdateItems(await status(), later)).toEqual([])
    await refuse('failed')
    expect((await status()).find(r => r.id === 'M')).toMatchObject({ updateState: 'failed' })
    expect(await needsYou()).toMatchObject([{ id: 'runner-M', online: false }])
  }, 60000)

  it('returns a failed build runner to placement and keeps the failure visible across reconnect', async () => {
    t = await createTestApp('pglite', { listen: true })
    const peer = await connect('failed', { commit: 'old', autoUpdate: true })
    expect(t.runner.available()).toEqual([])
    peer.send({ type: 'runner.update-status', draining: false, updateRequested: false, activeRunCount: 1, updateState: 'failed', updateError: 'Image build failed' })
    await vi.waitFor(() => expect(t.runner.available().map(r => r.id)).toContain('failed'), { timeout: 5000 })
    expect(await status()).toContainEqual(expect.objectContaining({ id: 'failed', draining: false, updateState: 'failed', activeRunCount: 1 }))
    peer.close()
    await vi.waitFor(() => expect(t.runner.isOnline('failed')).toBe(false), { timeout: 5000 })
    const retry = await connect('failed', { commit: 'old', autoUpdate: true, updateTarget: 'development', updateState: 'failed', updateError: 'Image build failed' })
    expect(t.runner.available().map(r => r.id)).toContain('failed')
    await t.request('POST', '/api/runners/failed/update')
    expect(await retry.next('runner.drain')).toMatchObject({ updateRequested: true })
    retry.close()
    await vi.waitFor(() => expect(t.runner.isOnline('failed')).toBe(false), { timeout: 5000 })
    await connect('failed', { commit: 'old', autoUpdate: true, updateTarget: 'previous-server', updateState: 'failed' })
    expect(t.runner.available()).toEqual([]) // A new server commit gets a fresh automatic attempt.
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
