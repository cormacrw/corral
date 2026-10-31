import { writeFile } from 'node:fs/promises'
import type { Inbox, PlanSessionDetail, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { auditLog, tasks } = schema

describe('confirm-required PM actions', () => {
  let t: TestApp
  let runner: FakeRunner
  let job: RunJob
  let session: PlanSessionDetail
  let slug: string

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    runner = await FakeRunner.connect(t.server!.url)
    const project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    slug = project.slug
    const response = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Clean up old tasks' })
    session = await response.json() as PlanSessionDetail
    job = (await runner.next('run.assign', m => m.job.planSessionId === session.id)).job
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'confirmation-session' })
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  async function propose(ref: string) {
    const response = await runner.call(job.runId, job.leaseEpoch, 'delete_task', { taskRef: ref })
    expect(response).toMatchObject({ ok: true, result: { confirmationPending: true } })
    return (response as { result: { actionId: string } }).result.actionId
  }
  const resolve = (id: string, decision: 'confirm' | 'cancel') => t.request('POST', `/api/plan/sessions/${session.id}/actions/${id}`, { decision })
  const detail = async () => (await t.request('GET', `/api/plan/sessions/${session.id}`)).json() as Promise<PlanSessionDetail>

  it('validates before proposing, changes nothing until Confirm, and records both actors and the PM session', async () => {
    const task = await t.createTask(slug, { title: 'Retire the old welcome page' })
    expect(await runner.call(job.runId, job.leaseEpoch, 'delete_task', {})).toMatchObject({ ok: false })
    expect(await runner.call(job.runId, job.leaseEpoch, 'delete_task', { taskRef: 'OTHER-1' })).toMatchObject({ ok: false })
    const id = await propose(task.ref)
    expect((await detail()).messages.find(m => m.id === id)).toMatchObject({ kind: 'confirmation', pendingAction: { status: 'pending', summary: `Delete ${task.ref}: Retire the old welcome page`, input: { taskRef: task.ref } } })
    expect((await t.request('GET', `/api/projects/${slug}/tasks/${task.number}`)).status).toBe(200)
    const [proposed] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm.action_proposed'))
    expect(proposed).toMatchObject({ actor: { kind: 'agent', role: 'pm', runId: job.runId }, detail: { actionId: id, sessionId: session.id, input: { taskRef: task.ref } } })
    const beforeInbox = await (await t.request('GET', '/api/inbox')).json() as Inbox
    expect(beforeInbox.activity.find(item => item.id === `pm-${proposed!.id}`)).toMatchObject({ taskId: task.id, taskRef: task.ref })
    // Racing requests and retries run the action once.
    const results = await Promise.all([resolve(id, 'confirm'), resolve(id, 'confirm')])
    expect(results.map(r => r.status)).toEqual([200, 200])
    expect((await resolve(id, 'confirm')).status).toBe(200)
    const deletedResponse = await t.request('GET', `/api/projects/${slug}/tasks/${task.number}`)
    expect(deletedResponse.status).toBe(404)
    const deleted = await t.db.select().from(auditLog).where(eq(auditLog.action, 'task.deleted'))
    expect(deleted).toHaveLength(1)
    expect(deleted[0]!.actor).toMatchObject({ kind: 'human', viaPm: { runId: job.runId, sessionId: session.id } })
    const confirmed = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm.action_confirmed'))
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]).toMatchObject({ actor: t.actor, detail: { actionId: id, sessionId: session.id, proposer: { kind: 'agent', runId: job.runId }, result: `Deleted ${task.ref}.` } })
    const inbox = await (await t.request('GET', '/api/inbox')).json() as Inbox
    for (const entry of [proposed!, confirmed[0]!]) {
      expect(inbox.activity.find(item => item.id === `pm-${entry.id}`)).toMatchObject({
        taskId: null, taskRef: null, project: { slug }, body: expect.stringContaining(`/plan/${session.id}`)
      })
    }
    if (process.env.CORRAL_PM_DELETE_EVIDENCE) await writeFile(process.env.CORRAL_PM_DELETE_EVIDENCE, JSON.stringify({
      before: { method: 'GET', path: '/api/inbox', response: beforeInbox },
      confirmation: { method: 'POST', path: `/api/plan/sessions/${session.id}/actions/${id}`, input: { decision: 'confirm' }, statuses: results.map(r => r.status), response: await results[0]!.json() },
      deletedTask: { method: 'GET', path: `/api/projects/${slug}/tasks/${task.number}`, status: deletedResponse.status, response: await deletedResponse.json() },
      after: { method: 'GET', path: '/api/inbox', response: inbox }
    }, null, 2))
    expect(inbox.activity).toContainEqual(expect.objectContaining({ sender: { name: 'PM', role: 'pm' }, body: expect.stringContaining(session.id) }))
  })

  it('keeps soft-deleted task activity without linking to the hidden task', async () => {
    const task = await t.createTask(slug, { title: 'Retire accepted work' })
    await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, task.id))
    const id = await propose(task.ref)
    expect((await resolve(id, 'confirm')).status).toBe(200)
    const [hidden] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(hidden!.deletedAt).not.toBeNull()
    expect((await t.request('GET', `/api/projects/${slug}/tasks/${task.number}`)).status).toBe(404)
    const inbox = await (await t.request('GET', '/api/inbox')).json() as Inbox
    const activity = inbox.activity.filter(item => item.subject.includes(task.ref))
    expect(activity).toHaveLength(2)
    for (const item of activity) expect(item).toMatchObject({ taskId: null, taskRef: null, project: { slug }, body: expect.stringContaining(`/plan/${session.id}`) })
  })

  it('Cancel leaves the target unchanged, records the decision, and cannot subsequently confirm it', async () => {
    const task = await t.createTask(slug, { title: 'Keep this page' })
    const id = await propose(task.ref)
    expect(await (await resolve(id, 'cancel')).json()).toMatchObject({ pendingAction: { status: 'cancelled' } })
    expect(await (await resolve(id, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'cancelled' } })
    expect((await t.request('GET', `/api/projects/${slug}/tasks/${task.number}`)).status).toBe(200)
    expect((await detail()).messages).toContainEqual(expect.objectContaining({ kind: 'action_result', text: expect.stringContaining(`Cancelled: Delete ${task.ref}`) }))
    const [cancelled] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm.action_cancelled'))
    expect(cancelled).toMatchObject({ actor: t.actor, detail: { actionId: id, sessionId: session.id, runId: job.runId } })
  })

  it('revalidates deleted and newly immutable targets and persists the card error without running', async () => {
    for (const invalidation of ['deleted', 'merged'] as const) {
      const task = await t.createTask(slug, { title: `Target becomes ${invalidation}` })
      const id = await propose(task.ref)
      if (invalidation === 'deleted') await t.request('DELETE', `/api/projects/${slug}/tasks/${task.number}`)
      else await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, task.id))
      const before = await t.db.select().from(auditLog).where(eq(auditLog.taskId, task.id))
      expect(await (await resolve(id, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed', error: expect.stringContaining(invalidation === 'deleted' ? 'no longer exists' : 'Merged tasks cannot') } })
      const after = await t.db.select().from(auditLog).where(eq(auditLog.taskId, task.id))
      expect(after.length).toBe(before.length + (invalidation === 'merged' ? 1 : 0))
      const failures = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm.action_failed'))
      expect(failures).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ actionId: id }) }))
      const [row] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
      expect(invalidation === 'deleted' ? !row || row.deletedAt !== null : row!.status === 'merged' && row!.deletedAt === null).toBe(true)
      expect((await detail()).messages.find(m => m.id === id)?.pendingAction?.status).toBe('failed')
    }
  })

  it('rejects a decision scoped to another conversation or made by an agent', async () => {
    const task = await t.createTask(slug)
    const id = await propose(task.ref)
    const other = crypto.randomUUID()
    expect((await t.request('POST', `/api/plan/sessions/${other}/actions/${id}`, { decision: 'confirm' })).status).toBe(404)
    await expect(t.orchestrator.pmActions.resolve(session.id, id, 'confirm', { kind: 'agent', role: 'pm', runId: job.runId })).rejects.toMatchObject({ status: 403 })
    expect((await detail()).messages.find(m => m.id === id)?.pendingAction?.status).toBe('pending')
  })

  it('recovers interrupted execution without replaying it and leaves other pending cards intact', async () => {
    const target = await t.createTask(slug)
    const id = await propose(target.ref)
    const waitingId = await propose(target.ref)
    const [row] = await t.db.select().from(schema.planMessages).where(eq(schema.planMessages.id, id))
    await t.db.update(schema.planMessages).set({ pendingAction: { ...row!.pendingAction!, status: 'executing' } }).where(eq(schema.planMessages.id, id))
    await t.orchestrator.pmActions.recoverInterrupted()
    expect((await detail()).messages.find(m => m.id === id)?.pendingAction).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') })
    expect((await detail()).messages.find(m => m.id === waitingId)?.pendingAction?.status).toBe('pending')
    expect((await t.request('GET', `/api/projects/${slug}/tasks/${target.number}`)).status).toBe(200)
    expect(await (await resolve(id, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed' } })
  })

  it('delivers confirmation and cancellation results on the next warm and cold PM turn', async () => {
    const nextMessage = 'What happened to those tasks?'
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await vi.waitFor(async () => expect((await detail()).activeRunId).toBeNull())
    expect((await t.request('POST', `/api/plan/sessions/${session.id}/messages`, { text: nextMessage })).status).toBe(201)
    const next = (await runner.next('run.assign', m => m.job.planSessionId === session.id)).job
    expect(next.agentSessionId).toBe('confirmation-session')
    for (const prompt of [next.prompt, next.fallbackPrompt]) {
      expect(prompt).toContain('Confirmed: Delete')
      expect(prompt).toContain('Cancelled: Delete')
      expect(prompt).toContain('Could not confirm: Delete')
    }
  })
})
