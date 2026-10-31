import type { Inbox, PlanMessage, PlanSessionDetail, Project, RunEvent, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq, ne } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { transcriptExcerpt } from './pm-tools.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { auditLog, runs, tasks } = schema

describe('transcriptExcerpt', () => {
  const events: RunEvent[] = [
    { type: 'system', text: 'started' },
    { type: 'thinking', text: 'hidden' },
    { type: 'tool_call', id: '1', tool: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', id: '1', output: 'a.txt', isError: false },
    { type: 'usage', inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 },
    { type: 'message', text: 'All done' }
  ]

  it('keeps a short transcript whole and leaves reasoning and usage out', () => {
    const { excerpt, truncated } = transcriptExcerpt(events, 1000)
    expect(truncated).toBe(false)
    expect(excerpt).toContain('[tool] Bash {"command":"ls"}')
    expect(excerpt).toContain('All done')
    expect(excerpt).not.toContain('hidden')
  })

  it('cuts to the end of the transcript, no longer than the limit, and says so', () => {
    const result = transcriptExcerpt(events, 10)
    expect(result.excerpt).toHaveLength(10)
    expect(result.excerpt.endsWith('All done')).toBe(true)
    expect(result).toMatchObject({ truncated: true, note: expect.stringContaining('last 10 of') })
  })
})

describe('PM tools for projects, runs and the factory', () => {
  let t: TestApp
  let runner: FakeRunner
  let job: RunJob
  let session: PlanSessionDetail
  let project: Project
  const transcript: unknown[] = []

  async function startSession(target: Project, text: string) {
    const created = await (await t.request('POST', '/api/plan/sessions', { projectId: target.id, text })).json() as PlanSessionDetail
    const assigned = (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job
    runner.send({ type: 'run.started', runId: assigned.runId, leaseEpoch: assigned.leaseEpoch, agentSessionId: `session-${created.id}` })
    return { session: created, job: assigned }
  }

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    t.request = async (method, path, body) => {
      const response = await fetch(`${t.server!.url}${path}`, { method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      transcript.push({ request: { method, path, body }, response: { status: response.status, body: await response.clone().text() } })
      return response
    }
    runner = await FakeRunner.connect(t.server!.url)
    project = await t.createProject({ repository: 'cormacrw/test-app', defaultBranch: 'main' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    ;({ session, job } = await startSession(project, 'Look after the factory'))
  })

  afterAll(async () => {
    if (process.env.CORRAL_PM_EVIDENCE_DIR) {
      await mkdir(process.env.CORRAL_PM_EVIDENCE_DIR, { recursive: true })
      await writeFile(join(process.env.CORRAL_PM_EVIDENCE_DIR, 'pm-hold-requests.json'), JSON.stringify(transcript, null, 2))
    }
    runner?.close()
    await t?.close()
  })

  const call = async (tool: Parameters<FakeRunner['call']>[2], input: unknown = {}, via = job) => {
    const response = await runner.call(via.runId, via.leaseEpoch, tool, input)
    transcript.push({ request: { transport: 'runner WebSocket', tool, input }, response })
    return response
  }
  const result = async <T>(tool: Parameters<FakeRunner['call']>[2], input: unknown = {}, via = job) => {
    const response = await call(tool, input, via) as { ok: boolean, result: T, error?: string }
    expect(response, response.error).toMatchObject({ ok: true })
    return response.result
  }
  const resolve = (sessionId: string, id: string, decision: 'confirm' | 'cancel') => t.request('POST', `/api/plan/sessions/${sessionId}/actions/${id}`, { decision })
  const inbox = async () => (await t.request('GET', '/api/inbox')).json() as Promise<Inbox>
  async function liveRun(status: 'running' | 'interrupted' = 'running') {
    const task = await t.createTask(project.slug, { title: `Work ${crypto.randomUUID()}` })
    const [pm] = await t.db.select().from(runs).where(eq(runs.id, job.runId))
    const [run] = await t.db.insert(runs).values({ agentId: pm!.agentId, projectId: project.id, taskId: task.id, role: 'developer', state: status, leaseEpoch: 1, runnerId: pm!.runnerId, summary: 'x'.repeat(5000), startedAt: new Date(), endedAt: status === 'running' ? null : new Date(), outcome: null }).returning()
    await t.db.update(tasks).set({ leaseRunId: run!.id, leaseEpoch: 1, leaseRole: 'developer', leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(tasks.id, task.id))
    return { task, run: run! }
  }

  it('reads projects, and refuses unknown fields', async () => {
    expect(await result('list_projects')).toMatchObject({ projects: [expect.objectContaining({ slug: project.slug })] })
    expect(await result('get_project', { project: project.slug })).toMatchObject({ id: project.id })
    expect(await call('get_project', { project: 'nope' })).toMatchObject({ ok: false, error: expect.stringContaining('not_found') })
    expect(await call('get_project', { project: project.slug, extra: 1 })).toMatchObject({ ok: false })
  })

  it('update_project changes a setting and attributes it to the PM session in Activity', async () => {
    expect(await call('update_project', { project: project.slug })).toMatchObject({ ok: false, error: expect.stringContaining('Nothing to change') })
    await result('update_project', { project: project.slug, reviewRoundCap: 9, requiredChecks: ['ci'] })
    expect(await (await t.request('GET', `/api/projects/${project.slug}`)).json()).toMatchObject({ reviewRoundCap: 9, requiredChecks: ['ci'] })
    const [updated] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'project.updated'))
    expect(updated).toMatchObject({ actor: { kind: 'agent', role: 'pm', runId: job.runId, sessionId: session.id } })
    const item = (await inbox()).activity.find(a => a.preview.includes('reviewRoundCap'))
    expect(item).toMatchObject({ type: 'activity', taskRef: null, sender: { name: 'PM', role: 'pm' }, project: { id: project.id } })
    expect(item!.body).toContain(`/plan/${session.id}`)
  })

  it('create_project needs every repository check to pass', async () => {
    const check = { kind: 'check_repo' } as const
    const reply = (found: boolean) => void runner.next('job.request', m => m.job.kind === check.kind).then(m => runner.send({ type: 'job.result', jobId: m.jobId, ok: true, result: { kind: 'check_repo', signedIn: true, found, canPush: found, cloned: found, defaultBranch: found ? 'trunk' : null, error: null } as never }))
    reply(false)
    expect(await call('create_project', { name: 'Nope', prefix: 'NOP', repository: 'acme/nope' })).toMatchObject({ ok: false, error: expect.stringContaining('was not created') })
    expect((await (await t.request('GET', '/api/projects')).json() as Project[]).some(p => p.name === 'Nope')).toBe(false)
    reply(true)
    const created = await result<Project>('create_project', { name: 'Yes', prefix: 'YES', repository: 'acme/yes' })
    expect(created).toMatchObject({ defaultBranch: 'trunk' })
    await t.request('PATCH', `/api/projects/${created.slug}`, { paused: true })
  })

  it('lists a task\'s runs with outcomes, filters and notes a cap; get_run caps its excerpt', async () => {
    const { task, run } = await liveRun('interrupted')
    await liveRun('interrupted')
    await t.transcripts.append(run.id, [{ type: 'message', text: 'y'.repeat(500) }])
    const listed = await result<{ runs: { id: string, outcome: string, summary: string }[], note: string }>('list_runs', { taskRef: task.ref })
    expect(listed.runs).toHaveLength(1)
    expect(listed.runs[0]).toMatchObject({ id: run.id, outcome: null })
    expect(listed.runs[0]!.summary.length).toBeLessThan(400)
    expect(listed.note).toContain('cut to')
    const limited = await result<{ runs: unknown[], note: string }>('list_runs', { project: project.slug, status: 'interrupted', limit: 1 })
    expect(limited.runs).toHaveLength(1)
    expect(limited.note).toContain('there are more')
    const got = await result<{ outcome: string, transcript: { excerpt: string, truncated: boolean, note: string } }>('get_run', { runId: run.id, transcriptLimit: 100 })
    expect(got.outcome).toBeNull()
    expect(got.transcript.excerpt).toHaveLength(100)
    expect(got.transcript).toMatchObject({ truncated: true, note: expect.stringContaining('100') })
  })

  it('message_run reaches the live run and refuses one that has ended', async () => {
    const { task, run } = await liveRun()
    const delivered = runner.next('run.message', m => m.runId === run.id)
    await result('message_run', { runId: run.id, text: 'Use the new endpoint' })
    expect((await delivered).text).toBe('From the PM: Use the new endpoint')
    const comments = await (await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/comments`)).json() as { body: string, author: unknown }[]
    expect(comments).toContainEqual(expect.objectContaining({ author: expect.objectContaining({ kind: 'agent', role: 'pm' }), body: expect.stringContaining('new endpoint') }))
    expect((await inbox()).activity.some(a => a.preview.includes('Use the new endpoint'))).toBe(true)
    const { run: ended } = await liveRun('interrupted')
    expect(await call('message_run', { runId: ended.id, text: 'Hello?' })).toMatchObject({ ok: false, error: expect.stringContaining('run_not_live') })
  })

  it('get_status matches the status and runner routes', async () => {
    const status = await (await t.request('GET', '/api/status')).json() as Record<string, unknown>
    const hub = await (await t.request('GET', '/api/runner')).json() as Record<string, unknown>
    expect(await result('get_status')).toMatchObject({ stopped: status.stopped, updating: status.updating, online: hub.online, protocol: hub.protocol, runners: [expect.objectContaining({ id: (status.runners as { id: string }[])[0]!.id })] })
  })

  it('requires confirmation before holding, then lets the human lift a latched hold', async () => {
    await t.db.update(runs).set({ state: 'interrupted', outcome: null, endedAt: new Date() }).where(ne(runs.role, 'pm'))
    const proposed = await result<{ actionId: string, confirmationPending: boolean }>('set_update_hold')
    expect(proposed.confirmationPending).toBe(true)
    expect(await (await t.request('GET', '/api/status')).json()).toMatchObject({ updating: false })
    const confirmed = await t.request('POST', `/api/plan/sessions/${session.id}/actions/${proposed.actionId}`, { decision: 'confirm' })
    expect(await confirmed.json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect(t.orchestrator.status.updating).toBe(true)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await vi.waitFor(async () => {
      const [ended] = await t.db.select().from(runs).where(eq(runs.id, job.runId))
      expect(ended!.state).toBe('completed')
    })
    const queued = await (await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Wait for update' })).json() as PlanSessionDetail
    await vi.waitFor(async () => {
      const current = await (await t.request('GET', `/api/plan/sessions/${queued.id}`)).json() as PlanSessionDetail
      queued.activeRunId = current.activeRunId
      expect(queued.activeRunId).not.toBeNull()
    })
    await t.orchestrator.schedule()
    const [held] = await t.db.select().from(runs).where(eq(runs.id, queued.activeRunId!))
    expect(held).toMatchObject({ state: 'queued', pmJob: expect.any(Object) })
    expect(await (await t.request('GET', `/api/runs/${queued.activeRunId}`)).json()).toMatchObject({ state: 'queued' })
    expect(await (await t.request('GET', '/api/status')).json()).toMatchObject({ updating: true })
    expect(await (await t.request('DELETE', '/api/update-hold')).json()).toMatchObject({ updating: false })
    const assignment = await runner.next('run.assign', m => m.job.runId === queued.activeRunId)
    transcript.push({ event: assignment })
    job = assignment.job
    session = queued
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'after-update-hold' })
    expect(await result('clear_update_hold')).toMatchObject({ updating: false })
  })

  it('audits every call with the PM session and shows reads and failures in Activity', async () => {
    await result('get_status')
    await call('get_project', { project: 'no-such-project' })
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm.tool_called'))
    expect(rows.find(r => (r.detail as { tool: string, runId: string }).tool === 'get_status' && (r.detail as { runId: string }).runId === job.runId)).toMatchObject({ actor: { sessionId: session.id }, detail: { sessionId: session.id, runId: job.runId, ok: true } })
    const activity = (await inbox()).activity
    const read = activity.find(a => a.preview === 'Checked Corral\'s status')
    expect(read).toMatchObject({ taskRef: null, sender: { name: 'PM', role: 'pm' } })
    expect(read!.body).toContain(`/plan/${session.id}`)
    const failed = activity.find(a => a.preview.startsWith('Could not read a project'))
    expect(failed!.preview).toBe('Could not read a project: not found')
    expect(failed!.body).toContain(`/plan/${session.id}`)
  })

  async function propose(tool: Parameters<FakeRunner['call']>[2], input: unknown = {}, via = job) {
    return (await result<{ confirmationPending: boolean, actionId: string }>(tool, input, via)).actionId
  }

  it('stop_run acts only after Confirm, and fails if the run has already ended', async () => {
    const { run } = await liveRun()
    const id = await propose('stop_run', { runId: run.id })
    expect((await t.db.select().from(runs).where(eq(runs.id, run.id)))[0]!.state).toBe('running')
    expect((await inbox()).activity.some(a => a.preview.startsWith(`Proposed: Stop run #${run.number}`))).toBe(true)
    expect(await (await resolve(session.id, id, 'cancel')).json()).toMatchObject({ pendingAction: { status: 'cancelled' } })
    expect((await t.db.select().from(runs).where(eq(runs.id, run.id)))[0]!.state).toBe('running')
    expect((await inbox()).activity.some(a => a.preview.startsWith(`Stop run #${run.number}`) && a.preview.endsWith('cancelled by you'))).toBe(true)
    const again = await propose('stop_run', { runId: run.id })
    expect(await (await resolve(session.id, again, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect((await t.db.select().from(runs).where(eq(runs.id, run.id)))[0]!.state).toBe('interrupted')
    const [stopped] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'run.stopped'))
    expect(stopped!.actor).toMatchObject({ kind: 'human', viaPm: { sessionId: session.id, runId: job.runId } })
    expect((await inbox()).activity.some(a => a.preview.startsWith(`Stop run #${run.number}`) && a.preview.endsWith('confirmed by you'))).toBe(true)
    expect(await call('stop_run', { runId: run.id })).toMatchObject({ ok: false, error: expect.stringContaining('isn\'t live') })

    const { run: raced } = await liveRun()
    const stale = await propose('stop_run', { runId: raced.id })
    await t.db.update(runs).set({ state: 'failed', endedAt: new Date() }).where(eq(runs.id, raced.id))
    expect(await (await resolve(session.id, stale, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed' } })
    expect((await inbox()).activity.some(a => a.preview.startsWith(`Could not confirm: Stop run #${raced.number}`))).toBe(true)
  })

  it('delete_project binds the card to the project, not its slug', async () => {
    const other = await t.createProject()
    const id = await propose('delete_project', { project: other.slug })
    const { messages } = await (await t.request('GET', `/api/plan/sessions/${session.id}`)).json() as { messages: PlanMessage[] }
    expect(messages.find(m => m.id === id)?.pendingAction).toMatchObject({ status: 'pending', targetId: other.id, summary: expect.stringContaining(`Remove project ${other.name}`) })
    expect((await t.request('GET', `/api/projects/${other.slug}`)).status).toBe(200)
    await t.request('DELETE', `/api/projects/${other.slug}`, { confirm: other.name })
    const replacement = await t.createProject({ slug: other.slug, name: 'Replacement' })
    await t.request('PATCH', `/api/projects/${replacement.slug}`, { paused: true })
    expect(await (await resolve(session.id, id, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed', error: expect.stringContaining('changed') } })
    expect((await t.request('GET', `/api/projects/${replacement.slug}`)).status).toBe(200)
  })

  it('delete_project can remove the conversation\'s own project and still records it', async () => {
    const doomed = await t.createProject({ name: 'Doomed' })
    await t.request('PATCH', `/api/projects/${doomed.slug}`, { paused: true })
    const own = await startSession(doomed, 'Remove this project')
    const id = await propose('delete_project', { project: doomed.slug }, own.job)
    const response = await resolve(own.session.id, id, 'confirm')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect((await t.request('GET', `/api/projects/${doomed.slug}`)).status).toBe(404)
    const deleted = (await t.db.select().from(auditLog).where(eq(auditLog.action, 'project.deleted'))).at(-1)
    expect(deleted!.actor).toMatchObject({ kind: 'human', viaPm: { sessionId: own.session.id } })
    const item = (await inbox()).activity.find(a => a.preview.startsWith('Remove project Doomed'))
    expect(item).toMatchObject({ project: { name: 'Removed project' }, taskRef: null })
    expect(item!.body).not.toContain('/plan/')
  })

  it('stop_all and resume_all act only after Confirm', async () => {
    const stop = await propose('stop_all')
    const resume = await propose('resume_all')
    expect((await (await t.request('GET', '/api/status')).json() as { stopped: boolean }).stopped).toBe(false)
    await resolve(session.id, stop, 'cancel')
    expect((await (await t.request('GET', '/api/status')).json() as { stopped: boolean }).stopped).toBe(false)
    const confirmStop = await propose('stop_all')
    expect(await (await resolve(session.id, confirmStop, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect((await (await t.request('GET', '/api/status')).json() as { stopped: boolean }).stopped).toBe(true)
    // The stop ended this PM turn, and the earlier card still works
    await vi.waitFor(async () => expect((await t.db.select().from(runs).where(eq(runs.id, job.runId)))[0]!.state).toBe('interrupted'))
    expect(await (await resolve(session.id, resume, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect((await (await t.request('GET', '/api/status')).json() as { stopped: boolean }).stopped).toBe(false)
  })
})
