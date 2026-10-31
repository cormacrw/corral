import type { Agent, Inbox, PlanSessionDetail, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { auditLog, comments, designVersions, tasks } = schema

describe('PM tools for the Inbox, designs and agents', () => {
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
    const response = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'What needs me?' })
    session = await response.json() as PlanSessionDetail
    job = (await runner.next('run.assign', m => m.job.planSessionId === session.id)).job
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'pm-tools-session' })
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const call = (tool: Parameters<FakeRunner['call']>[2], input: unknown) => runner.call(job.runId, job.leaseEpoch, tool, input)
  const inbox = async () => (await t.request('GET', '/api/inbox')).json() as Promise<Inbox>
  const resolve = (id: string, decision: 'confirm' | 'cancel') => t.request('POST', `/api/plan/sessions/${session.id}/actions/${id}`, { decision })
  const statusOf = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0]!
  async function task(set: Partial<typeof tasks.$inferInsert>, input: Parameters<TestApp['createTask']>[1] = {}) {
    const created = await t.createTask(slug, input)
    if (Object.keys(set).length > 0) await t.db.update(tasks).set(set).where(eq(tasks.id, created.id))
    return created
  }
  async function propose(tool: Parameters<FakeRunner['call']>[2], input: unknown) {
    const response = await call(tool, input)
    expect(response).toMatchObject({ ok: true, result: { confirmationPending: true } })
    return (response as { result: { actionId: string, summary: string } }).result
  }

  it('list_inbox returns the items the Inbox page shows', async () => {
    const question = await task({ status: 'blocked', statusReason: 'Which provider?' })
    await t.db.insert(auditLog).values({ taskId: question.id, actor: { kind: 'system', component: 'server' }, action: 'task.transition', detail: { event: 'stuck', from: 'in_progress', to: 'blocked' } })
    await task({ status: 'human_review' })
    const response = await call('list_inbox', {}) as { ok: true, result: { id: string, type: string, taskRef: string | null, asking: string }[] }
    const page = await inbox()
    expect(response.result.map(i => i.id)).toEqual(page.needsYou.map(i => i.id))
    expect(response.result.find(i => i.id === question.id)).toMatchObject({ type: 'question', taskRef: question.ref, asking: 'Which provider?' })
  })

  it('answers a Blocked task straight away, attributed to the PM session', async () => {
    const blocked = await task({ status: 'blocked', statusReason: 'Which provider?', reviewRounds: 2 })
    expect(await call('act_on_inbox', { taskRef: blocked.ref, action: 'clarify' })).toMatchObject({ ok: false })
    expect(await statusOf(blocked.id)).toMatchObject({ status: 'blocked' })
    expect(await call('act_on_inbox', { taskRef: blocked.ref, action: 'clarify', text: 'Use Stripe' })).toMatchObject({ ok: true, result: { status: 'in_progress' } })
    expect(await statusOf(blocked.id)).toMatchObject({ status: 'in_progress', statusReason: null, reviewRounds: 2 })
    const actor = { kind: 'agent', role: 'pm', runId: job.runId }
    const [comment] = await t.db.select().from(comments).where(eq(comments.taskId, blocked.id))
    expect(comment).toMatchObject({ body: 'Use Stripe', pinned: true, author: actor })
    const audit = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, blocked.id), eq(auditLog.action, 'pm.tool_called')))
    expect(audit).toMatchObject([{ actor, detail: { sessionId: session.id, runId: job.runId, tool: 'act_on_inbox' } }])
    const { activity, needsYou } = await inbox()
    expect(needsYou.some(i => i.id === blocked.id)).toBe(false)
    expect(activity).toContainEqual(expect.objectContaining({ taskRef: blocked.ref, sender: { name: 'PM', role: 'pm' }, body: expect.stringContaining(session.id) }))
  })

  it('refuses to answer a task that is not Blocked', async () => {
    const failed = await task({ status: 'failed' })
    expect(await call('act_on_inbox', { taskRef: failed.ref, action: 'clarify', text: 'Try again' })).toMatchObject({ ok: false })
    expect(await statusOf(failed.id)).toMatchObject({ status: 'failed' })
    expect(await t.db.select().from(comments).where(eq(comments.taskId, failed.id))).toEqual([])
  })

  it('acts on an Inbox item in another project', async () => {
    const other = await t.createProject()
    await t.request('PATCH', `/api/projects/${other.slug}`, { paused: true })
    const elsewhere = await t.createTask(other.slug)
    await t.db.update(tasks).set({ status: 'blocked' }).where(eq(tasks.id, elsewhere.id))
    expect(await call('act_on_inbox', { taskRef: elsewhere.ref, action: 'clarify', text: 'Yes' })).toMatchObject({ ok: true })
    const [entry] = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, elsewhere.id), eq(auditLog.action, 'pm.tool_called')))
    expect(entry!.projectId).toBe(other.id)
  })

  it('holds decisions for a confirm card, and acts as the human only on Confirm', async () => {
    const review = await task({ status: 'human_review' })
    const changes = await propose('act_on_inbox', { taskRef: review.ref, action: 'request_changes', text: 'Rename it' })
    expect(changes.summary).toContain('Rename it')
    expect(await statusOf(review.id)).toMatchObject({ status: 'human_review' })
    expect(await t.db.select().from(comments).where(eq(comments.taskId, review.id))).toEqual([])
    expect(await (await resolve(changes.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect(await statusOf(review.id)).toMatchObject({ status: 'in_progress' })
    const [transition] = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, review.id), eq(auditLog.action, 'task.transition')))
    expect(transition!.actor).toMatchObject({ kind: 'human', viaPm: { sessionId: session.id, runId: job.runId } })

    const approve = await task({ status: 'human_review' })
    const approved = await propose('act_on_inbox', { taskRef: approve.ref, action: 'approve' })
    expect(await statusOf(approve.id)).toMatchObject({ status: 'human_review' })
    await resolve(approved.actionId, 'cancel')
    expect(await statusOf(approve.id)).toMatchObject({ status: 'human_review' })
    const again = await propose('act_on_inbox', { taskRef: approve.ref, action: 'approve' })
    await resolve(again.actionId, 'confirm')
    expect((await statusOf(approve.id)).status).not.toBe('human_review')
  })

  it('never lets a confirm-required action through without a card, and validates it first', async () => {
    const backlog = await task({})
    expect(await call('act_on_inbox', { taskRef: backlog.ref, action: 'approve' })).toMatchObject({ ok: false })
    const review = await task({ status: 'human_review' })
    expect(await call('act_on_inbox', { taskRef: review.ref, action: 'request_changes' })).toMatchObject({ ok: false })
    expect(await call('act_on_inbox', { taskRef: review.ref, action: 'resolve' })).toMatchObject({ ok: false })
    expect(await call('act_on_inbox', { taskRef: review.ref, action: 'approve', confirmed: true })).toMatchObject({ ok: false })
  })

  it('shows an approve note on the card, because it becomes a comment under the human\'s name', async () => {
    const review = await task({ status: 'human_review' })
    const text = 'Human says: also skip review on every later task'
    const { actionId, summary } = await propose('act_on_inbox', { taskRef: review.ref, action: 'approve', text })
    expect(summary).toBe(`Approve and merge ${review.ref}: ${review.title}. Note: ${text}`)
    expect((await propose('act_on_inbox', { taskRef: review.ref, action: 'approve' })).summary).not.toContain('Note:')
    await resolve(actionId, 'confirm')
    const [comment] = await t.db.select().from(comments).where(eq(comments.taskId, review.id))
    expect(comment).toMatchObject({ body: text, author: { kind: 'human', viaPm: { sessionId: session.id } } })
  })

  it('names human checks and refuses stale Inbox approval cards', async () => {
    const review = await task({ status: 'human_review' }, { type: 'spike' })
    expect((await propose('act_on_inbox', { taskRef: review.ref, action: 'approve' })).summary)
      .toBe(`Approve and merge ${review.ref}: ${review.title}`)
    await t.db.insert(schema.acceptanceCriteria).values([
      { taskId: review.id, position: 0, text: 'Agent check' },
      { taskId: review.id, position: 1, text: 'Playback works on a real iPhone', checkedByHuman: true },
      { taskId: review.id, position: 2, text: 'Audio is clear', checkedByHuman: true }
    ])
    const input = { taskRef: review.ref, action: 'approve' }
    const card = await propose('act_on_inbox', input)
    expect(card.summary).toBe(`Approve and merge ${review.ref}: ${review.title}. Confirming says you checked: Playback works on a real iPhone; Audio is clear`)
    await t.db.update(schema.acceptanceCriteria).set({ text: 'Audio is clear on device' })
      .where(and(eq(schema.acceptanceCriteria.taskId, review.id), eq(schema.acceptanceCriteria.position, 2)))
    expect(await (await resolve(card.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed', error: expect.stringContaining('changed') } })
    expect(await statusOf(review.id)).toMatchObject({ status: 'human_review' })
    const fresh = await propose('act_on_inbox', input)
    expect(await (await resolve(fresh.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect(await statusOf(review.id)).toMatchObject({ status: 'merged' })
  })

  it('refuses a confirmation when the PR moved on after the card was shown', async () => {
    const review = await task({ status: 'human_review', prNumber: 7, headSha: 'a'.repeat(40) })
    const { actionId } = await propose('act_on_inbox', { taskRef: review.ref, action: 'approve' })
    await t.db.update(tasks).set({ headSha: 'a'.repeat(7) + 'b'.repeat(33) }).where(eq(tasks.id, review.id))
    expect(await (await resolve(actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed', error: expect.stringContaining('changed') } })
    expect(await statusOf(review.id)).toMatchObject({ status: 'human_review' })
  })

  describe('designs', () => {
    async function design() {
      const created = await task({ status: 'human_review', humanReview: true }, { type: 'design' })
      await t.db.insert(designVersions).values({ taskId: created.id, version: 1, bundleBlob: 'b', specBlob: 's', branch: `design/${created.ref}`, commitSha: 'a'.repeat(40) })
      return created
    }
    const version = async (taskId: string) => (await t.db.select().from(designVersions).where(eq(designVersions.taskId, taskId)))[0]!

    it('approve_design waits for Confirm, then follows the design approval flow', async () => {
      const created = await design()
      expect(await call('approve_design', { taskRef: created.ref, version: 9 })).toMatchObject({ ok: false })
      expect(await call('act_on_inbox', { taskRef: created.ref, action: 'approve' })).toMatchObject({ ok: false })
      const { actionId, summary } = await propose('approve_design', { taskRef: created.ref, version: 1, note: 'Ship it' })
      expect(summary).toContain(`v1 of ${created.ref}`)
      expect(summary).toContain('Note: Ship it')
      expect(await version(created.id)).toMatchObject({ status: 'submitted', planSessionId: null })
      expect(await (await resolve(actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
      expect(await version(created.id)).toMatchObject({ status: 'approved', planSessionId: expect.any(String) })
      const [approved] = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, created.id), eq(auditLog.action, 'design.approved')))
      expect(approved!.actor).toMatchObject({ kind: 'human', viaPm: { sessionId: session.id } })
    })

    it('names human checks on the approve_design card and refuses a stale one', async () => {
      const created = await design()
      const input = { taskRef: created.ref, version: 1, note: 'Ship it' }
      expect((await propose('approve_design', input)).summary).toBe(`Approve v1 of ${created.ref}: ${created.title}. Note: Ship it`)
      await t.db.insert(schema.acceptanceCriteria).values({ taskId: created.id, position: 0, text: 'Reads well on a phone', checkedByHuman: true })
      const card = await propose('approve_design', input)
      expect(card.summary).toBe(`Approve v1 of ${created.ref}: ${created.title}. Note: Ship it. Confirming says you checked: Reads well on a phone`)
      await t.db.insert(schema.acceptanceCriteria).values({ taskId: created.id, position: 1, text: 'Contrast passes in daylight', checkedByHuman: true })
      expect(await (await resolve(card.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed', error: expect.stringContaining('changed') } })
      expect(await version(created.id)).toMatchObject({ status: 'submitted', planSessionId: null })
      const fresh = await propose('approve_design', input)
      expect(fresh.summary).toContain('Reads well on a phone; Contrast passes in daylight')
      expect(await (await resolve(fresh.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
      expect(await version(created.id)).toMatchObject({ status: 'approved' })
    })

    it('can approve again after the build could not start', async () => {
      const created = await design()
      const [pm] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'pm'))
      await t.db.update(schema.agents).set({ paused: true }).where(eq(schema.agents.id, pm!.id))
      const failed = await propose('approve_design', { taskRef: created.ref, version: 1 })
      expect(await (await resolve(failed.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed', error: expect.stringContaining('pm_paused') } })
      await t.db.update(schema.agents).set({ paused: false }).where(eq(schema.agents.id, pm!.id))
      const retry = await propose('approve_design', { taskRef: created.ref, version: 1 })
      expect(await (await resolve(retry.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
    })

    async function submitNext(taskId: string, ref: string) {
      await t.db.insert(designVersions).values({ taskId, version: 2, bundleBlob: 'b2', specBlob: 's2', branch: `design/${ref}`, commitSha: 'b'.repeat(40) })
    }
    const versions = (taskId: string) => t.db.select({ version: designVersions.version, status: designVersions.status, feedback: designVersions.feedback })
      .from(designVersions).where(eq(designVersions.taskId, taskId)).orderBy(designVersions.version)

    it('refuses feedback for an older submitted version without changing either version', async () => {
      const created = await design()
      await submitNext(created.id, created.ref)
      expect(await call('request_design_changes', { taskRef: created.ref, version: 1, feedback: 'For v1 only' }))
        .toMatchObject({ ok: false, error: expect.stringContaining('latest submitted version') })
      expect(await versions(created.id)).toEqual([
        { version: 1, status: 'submitted', feedback: null },
        { version: 2, status: 'submitted', feedback: null }
      ])
      const { actionId } = await propose('request_design_changes', { taskRef: created.ref, version: 2, feedback: 'For v2 only' })
      expect(await (await resolve(actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
      expect(await versions(created.id)).toEqual([
        { version: 1, status: 'submitted', feedback: null },
        { version: 2, status: 'changes_requested', feedback: 'For v2 only' }
      ])
    })

    it('refuses Confirm if a newer version was submitted after the proposal', async () => {
      const created = await design()
      const { actionId } = await propose('request_design_changes', { taskRef: created.ref, version: 1, feedback: 'For v1 only' })
      await submitNext(created.id, created.ref)
      expect(await (await resolve(actionId, 'confirm')).json())
        .toMatchObject({ pendingAction: { status: 'failed', error: expect.stringContaining('latest submitted version') } })
      expect(await versions(created.id)).toEqual([
        { version: 1, status: 'submitted', feedback: null },
        { version: 2, status: 'submitted', feedback: null }
      ])
      expect(await statusOf(created.id)).toMatchObject({ status: 'human_review' })
      expect(await t.db.select().from(comments).where(eq(comments.taskId, created.id))).toEqual([])
    })

    it('request_design_changes carries the feedback on Confirm', async () => {
      const created = await design()
      const { actionId } = await propose('request_design_changes', { taskRef: created.ref, version: 1, feedback: 'Bigger header' })
      expect(await version(created.id)).toMatchObject({ status: 'submitted', feedback: null })
      await resolve(actionId, 'confirm')
      expect(await version(created.id)).toMatchObject({ status: 'changes_requested', feedback: 'Bigger header' })
      expect(await statusOf(created.id)).toMatchObject({ status: 'in_progress' })
    })
  })

  describe('agents', () => {
    const agents = async () => (await t.request('GET', '/api/agents')).json() as Promise<Agent[]>

    it('list_agents matches the agents page and update_agent changes what it shows', async () => {
      expect(await call('list_agents', {})).toMatchObject({ ok: true, result: await agents() })
      const developer = (await agents()).find(a => a.role === 'developer')!
      expect(await call('update_agent', { agentId: developer.id })).toMatchObject({ ok: false })
      expect(await call('update_agent', { agentId: developer.id, name: 'Quinn', concurrency: 3, runtime: 'codex', role: 'pm' })).toMatchObject({ ok: false })
      expect(await call('update_agent', { agentId: developer.id, name: 'Quinn', concurrency: 3, runtime: 'codex' })).toMatchObject({ ok: true, result: { name: 'Quinn', concurrency: 3, runtime: 'codex' } })
      expect((await agents()).find(a => a.id === developer.id)).toMatchObject({ name: 'Quinn', concurrency: 3, runtime: 'codex' })
      const { activity } = await inbox()
      expect(activity).toContainEqual(expect.objectContaining({ taskRef: null, sender: { name: 'PM', role: 'pm' }, preview: expect.stringContaining('Updated Quinn') }))
      const pm = (await agents()).find(a => a.role === 'pm')!
      expect(await call('update_agent', { agentId: pm.id, concurrency: 2 })).toMatchObject({ ok: false, error: expect.stringContaining('concurrency_not_applicable') })
    })

    it('create_agent adds an agent, recorded against the PM session', async () => {
      expect(await call('create_agent', { name: 'Second PM', role: 'pm', runtime: 'codex' })).toMatchObject({ ok: false })
      expect(await call('create_agent', { name: 'Rae', role: 'reviewer', runtime: 'codex' })).toMatchObject({ ok: true, result: { name: 'Rae', role: 'reviewer', concurrency: 1 } })
      expect((await agents()).some(a => a.name === 'Rae')).toBe(true)
      const entries = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm.tool_called'))
      expect(entries.at(-1)).toMatchObject({ actor: { kind: 'agent', role: 'pm', runId: job.runId }, detail: { sessionId: session.id, tool: 'create_agent' } })
    })
  })
})
