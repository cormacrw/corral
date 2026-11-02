import type { Agent, Inbox, PlanSessionDetail, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { acceptanceCriteria, auditLog, comments, designVersions, tasks } = schema

const STOP = { runId: null, target: null, human: '', status: 'in_progress' as const, capped: false, sessionId: null }

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
  // A Blocked task, as the transition that blocked it would have left it
  async function blockedBy(event: string, input: Parameters<TestApp['createTask']>[1] = {}) {
    const created = await task({ status: 'blocked', statusReason: 'Which provider?' }, input)
    await t.db.insert(auditLog).values({ taskId: created.id, projectId: created.projectId, actor: { kind: 'system', component: 'server' }, action: 'task.transition', detail: { event, from: 'in_progress', to: 'blocked' } })
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
    expect(response.result.map(i => i.id)).toEqual(page.needsYou.map(i => i.id))
  })

  it('keeps an epic rebase product decision waiting for the human', async () => {
    const question = 'Which behaviour should the rebase preserve?'
    const blocked = await task({ status: 'blocked', statusReason: question })
    const [epic] = await t.db.insert(schema.epics).values({ projectId: blocked.projectId, title: 'Rebase', createdBy: t.actor }).returning()
    const [operation] = await t.db.insert(schema.taskIntegrationOperations).values({
      epicId: epic!.id, kind: 'rebase', expectedTargetSha: 'old-head', ontoSha: 'new-base',
      resolutionTaskId: blocked.id, leaseEpoch: 0,
      decisions: [{ id: 'decision', runId: job.runId, raisedAt: new Date().toISOString(), question, alternatives: [], affectedChanges: ['app.ts'], answer: null }]
    }).returning()
    expect(await call('act_on_inbox', { taskRef: blocked.ref, action: 'clarify', text: 'Choose for me' })).toMatchObject({ ok: false })
    expect(await statusOf(blocked.id)).toMatchObject({ status: 'blocked', statusReason: question })
    expect(await t.db.select().from(comments).where(eq(comments.taskId, blocked.id))).toEqual([])
    const [unchanged] = await t.db.select().from(schema.taskIntegrationOperations).where(eq(schema.taskIntegrationOperations.id, operation!.id))
    expect(unchanged!.decisions).toEqual(operation!.decisions)
  })

  it('answers a Blocked task straight away, attributed to the PM session', async () => {
    const blocked = await blockedBy('stuck')
    await t.db.update(tasks).set({ reviewRounds: 2 }).where(eq(tasks.id, blocked.id))
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

  it.each(['review_cap', 'blocked', 'block'])('leaves a %s block to the human, so an answer can\'t lift a cap', async (event) => {
    const capped = await blockedBy(event)
    const reply = await call('act_on_inbox', { taskRef: capped.ref, action: 'clarify', text: 'Keep going' }) as { ok: false, error: string }
    expect(reply).toMatchObject({ ok: false })
    expect(reply.error).toContain('the human')
    expect(await statusOf(capped.id)).toMatchObject({ status: 'blocked' })
    expect(await t.db.select().from(comments).where(eq(comments.taskId, capped.id))).toEqual([])
  })

  it('points clarify on a Stopped item at the actions that apply', async () => {
    const stopped = await task({ status: 'in_progress', retryStop: STOP })
    const reply = await call('act_on_inbox', { taskRef: stopped.ref, action: 'clarify', text: 'Try again' }) as { ok: false, error: string }
    expect(reply.error).toContain('retry or resolve')
    expect(await statusOf(stopped.id)).toMatchObject({ retryStop: STOP })
  })

  it('says on the card what a Stopped item really does, and keeps a retry\'s note', async () => {
    const stopped = await task({ status: 'agent_review', retryStop: STOP })
    const resolved = await propose('act_on_inbox', { taskRef: stopped.ref, action: 'resolve', to: 'ready' })
    expect(resolved.summary).toContain(`Release the stop on ${stopped.ref}, which carries on in agent review`)
    await resolve(resolved.actionId, 'cancel')
    const retried = await propose('act_on_inbox', { taskRef: stopped.ref, action: 'retry', text: 'The fixture is back' })
    expect(retried.summary).toContain('Note: The fixture is back')
    await resolve(retried.actionId, 'confirm')
    expect(await t.db.select().from(comments).where(eq(comments.taskId, stopped.id))).toMatchObject([{ body: 'The fixture is back', pinned: true }])
  })

  describe('gates', () => {
    const lowered = async (tool: Parameters<FakeRunner['call']>[2], input: unknown, words: string) => {
      const card = await propose(tool, input)
      expect(card.summary).toContain(words)
      return card
    }

    it('takes a card to turn off human review, and acts as the human on Confirm', async () => {
      const gated = await task({ humanReview: true })
      const card = await lowered('update_task', { taskRef: gated.ref, humanReview: false, title: 'Renamed' }, 'turn off human review')
      expect(card.summary).toContain('Also changes title to "Renamed"')
      expect(await statusOf(gated.id)).toMatchObject({ humanReview: true })
      await resolve(card.actionId, 'confirm')
      expect(await statusOf(gated.id)).toMatchObject({ humanReview: false, title: 'Renamed' })
      const [confirmed] = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, gated.id), eq(auditLog.action, 'pm.action_confirmed')))
      expect(confirmed).toBeTruthy()
    })

    it('stays direct when it raises a gate or leaves it alone', async () => {
      const open = await task({ humanReview: false })
      expect(await call('update_task', { taskRef: open.ref, humanReview: true })).toMatchObject({ ok: true, result: { humanReview: true } })
      expect(await statusOf(open.id)).toMatchObject({ humanReview: true })
    })

    it('takes a card to remove or clear a human check', async () => {
      const checked = await t.createTask(slug, { acceptanceCriteria: [{ text: 'A person checks it', checkedByHuman: true }, 'Tests pass'] })
      const [human, plain] = await t.db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, checked.id)).orderBy(acceptanceCriteria.position)
      await lowered('update_task', { taskRef: checked.ref, acceptanceCriteria: [{ id: plain!.id, text: plain!.text }] }, 'remove the human check "A person checks it"')
      await lowered('update_task', { taskRef: checked.ref, acceptanceCriteria: [{ id: human!.id, text: human!.text, checkedByHuman: false }] }, 'stop requiring a human for "A person checks it"')
      expect(await call('update_task', { taskRef: checked.ref, acceptanceCriteria: [{ id: human!.id, text: human!.text }, { id: plain!.id, text: plain!.text, checkedByHuman: true }] })).toMatchObject({ ok: true, result: { ref: checked.ref } })
    })

    it('takes a card to resume a paused task', async () => {
      const paused = await task({ paused: true })
      const card = await lowered('update_task', { taskRef: paused.ref, paused: false }, 'resume the paused task')
      expect(await statusOf(paused.id)).toMatchObject({ paused: true })
      await resolve(card.actionId, 'confirm')
      expect(await statusOf(paused.id)).toMatchObject({ paused: false })
    })

    it('takes a card for less review on an epic, not more', async () => {
      const { id: projectId } = await (await t.request('GET', `/api/projects/${slug}`)).json() as { id: string }
      const [epic] = await t.db.insert(schema.epics).values({ projectId, title: 'Gated', reviewMode: 'epic', createdBy: t.actor }).returning()
      await lowered('update_epic', { epicId: epic!.id, reviewMode: 'direct' }, 'from epic to direct')
      expect(await call('update_epic', { epicId: epic!.id, reviewMode: 'each_task' })).toMatchObject({ ok: true, result: { reviewMode: 'each_task' } })
      await lowered('update_epic', { epicId: epic!.id, reviewMode: 'epic' }, 'from each_task to epic')
    })

    it('takes a card to lower a project\'s gates, and applies them on Confirm', async () => {
      await t.request('PATCH', `/api/projects/${slug}`, { requiredChecks: ['ci', 'lint'], humanReviewDefault: true, reviewRoundCap: 3, failedRunCap: 3 })
      await lowered('update_project', { project: slug, requiredChecks: ['ci'] }, 'stop requiring lint')
      await lowered('update_project', { project: slug, humanReviewDefault: false }, 'turn off human review by default')
      await lowered('update_project', { project: slug, failedRunCap: 9 }, 'raise the failed run cap from 3 to 9')
      const card = await lowered('update_project', { project: slug, reviewRoundCap: 9 }, 'raise the review round cap from 3 to 9')
      await resolve(card.actionId, 'confirm')
      expect(await (await t.request('GET', `/api/projects/${slug}`)).json()).toMatchObject({ reviewRoundCap: 9, requiredChecks: ['ci', 'lint'] })
      expect(await call('update_project', { project: slug, reviewRoundCap: 2, requiredChecks: ['ci', 'lint', 'test'] })).toMatchObject({ ok: true, result: { reviewRoundCap: 2 } })
    })

    it('refuses a criterion id twice, the route around the human check', async () => {
      const checked = await t.createTask(slug, { acceptanceCriteria: [{ text: 'A person checks it', checkedByHuman: true }] })
      const [human] = await t.db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, checked.id))
      const same = { id: human!.id, text: human!.text }
      expect(await call('update_task', { taskRef: checked.ref, acceptanceCriteria: [{ ...same, checkedByHuman: true }, { ...same, checkedByHuman: false }] })).toMatchObject({ ok: false })
      expect(await statusOf(checked.id)).toBeTruthy()
      expect((await t.db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, checked.id)))[0]).toMatchObject({ checkedByHuman: true })
    })

    it('takes a card to reword a human check', async () => {
      const checked = await t.createTask(slug, { acceptanceCriteria: [{ text: 'A person checks it', checkedByHuman: true }] })
      const [human] = await t.db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, checked.id))
      await lowered('update_task', { taskRef: checked.ref, acceptanceCriteria: [{ id: human!.id, text: 'n/a' }, { text: 'A person checks it' }] }, 'reword the human check "A person checks it" to "n/a"')
    })

    it('takes a card to move a task somewhere with less human review', async () => {
      const { id: projectId } = await (await t.request('GET', `/api/projects/${slug}`)).json() as { id: string }
      const epicOf = async (reviewMode: 'each_task' | 'epic' | 'direct') => (await t.db.insert(schema.epics).values({ projectId, title: reviewMode, reviewMode, createdBy: t.actor }).returning())[0]!
      const [strict, plain, direct] = [await epicOf('each_task'), await epicOf('epic'), await epicOf('direct')]
      const inStrict = await task({ humanReview: false, epicId: strict.id })
      await lowered('update_task', { taskRef: inStrict.ref, epicId: null }, 'move it somewhere with less human review')
      await lowered('update_task', { taskRef: inStrict.ref, epicId: direct.id }, 'move it somewhere with less human review')
      expect(await statusOf(inStrict.id)).toMatchObject({ epicId: strict.id })
      const loose = await task({ humanReview: false, epicId: direct.id })
      expect(await call('update_task', { taskRef: loose.ref, epicId: plain.id })).toMatchObject({ ok: true, result: { ref: loose.ref } })
      // Its own flag keeps a human on it wherever it goes
      const flagged = await task({ humanReview: true, epicId: strict.id })
      expect(await call('update_task', { taskRef: flagged.ref, epicId: null })).toMatchObject({ ok: true, result: { ref: flagged.ref } })
    })

    it('takes a card to retype a spike into work with no human review', async () => {
      const spike = await task({ humanReview: false, type: 'spike', status: 'backlog' })
      await lowered('update_task', { taskRef: spike.ref, type: 'task' }, 'turn off human review')
    })

    it('takes a card to resume a paused project', async () => {
      await t.request('PATCH', `/api/projects/${slug}`, { paused: true })
      const card = await lowered('update_project', { project: slug, paused: false }, 'resume the paused project')
      expect(await (await t.request('GET', `/api/projects/${slug}`)).json()).toMatchObject({ paused: true })
      await resolve(card.actionId, 'confirm')
      expect(await (await t.request('GET', `/api/projects/${slug}`)).json()).toMatchObject({ paused: false })
      await t.request('PATCH', `/api/projects/${slug}`, { paused: true })
    })

    it('takes a card to create a task below the project\'s review default', async () => {
      await t.request('PATCH', `/api/projects/${slug}`, { humanReviewDefault: true })
      const card = await lowered('create_task', { title: 'Unreviewed', type: 'task', humanReview: false }, 'without human review')
      await resolve(card.actionId, 'confirm')
      const [created] = await t.db.select().from(tasks).where(eq(tasks.title, 'Unreviewed'))
      expect(created).toMatchObject({ humanReview: false })
      expect(await call('create_task', { title: 'Reviewed', type: 'task', humanReview: true })).toMatchObject({ ok: true })
    })

    it('names what a deletion drops, and what a resolve resets', async () => {
      const checked = await t.createTask(slug, { humanReview: true, acceptanceCriteria: [{ text: 'A person checks it', checkedByHuman: true }] })
      const card = await propose('delete_task', { taskRef: checked.ref })
      expect(card.summary).toContain('This drops its human review, the human check "A person checks it"')
      const failed = await task({ status: 'failed', statusReason: 'Three failed runs', failedRuns: 3 })
      expect((await propose('act_on_inbox', { taskRef: failed.ref, action: 'resolve', to: 'ready' })).summary).toContain('resets its failed run count from 3 to 0')
      const capped = await task({ status: 'blocked', statusReason: 'Review cap', reviewRounds: 4 })
      expect((await propose('act_on_inbox', { taskRef: capped.ref, action: 'resolve', to: 'ready' })).summary).toContain('resets its review round count from 4 to 0')
    })

    it('fails a card whose gate was lowered meanwhile', async () => {
      const gated = await task({ humanReview: true })
      const card = await propose('update_task', { taskRef: gated.ref, humanReview: false })
      await t.db.update(tasks).set({ humanReview: false }).where(eq(tasks.id, gated.id))
      expect(await (await resolve(card.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed' } })
    })
  })

  it('shows the PM\'s direct edits in Activity, failed ones too', async () => {
    const created = await call('create_task', { title: 'From the PM', type: 'task' }) as { ok: true, result: { id: string, ref: string } }
    const edited = await call('update_task', { taskRef: created.result.ref, title: 'Retitled' })
    expect(edited).toMatchObject({ ok: true })
    expect(await call('update_task', { taskRef: 'NOPE-1', title: 'Lost' })).toMatchObject({ ok: false })
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm.tool_called'))
    const details = audit.map(a => a.detail as { tool: string, ok: boolean })
    expect(details.filter(d => d.tool === 'create_task' && d.ok)).not.toHaveLength(0)
    expect(details.filter(d => d.tool === 'update_task' && d.ok)).not.toHaveLength(0)
    expect(details.filter(d => d.tool === 'update_task' && !d.ok)).not.toHaveLength(0)
    expect((await inbox()).activity).toContainEqual(expect.objectContaining({ taskRef: created.result.ref, sender: { name: 'PM', role: 'pm' } }))
  })

  describe('plans', () => {
    const plan = (over: Record<string, unknown>, epics: unknown[] = []) => ({ title: 'Revision', summary: 'x', epics, tasks: [{ key: 'a', title: 'A', description: 'd', type: 'task', acceptanceCriteria: ['c'], ...over }] })
    const refused = async (input: unknown, words: string) => {
      const reply = await call('propose_plan', input) as { ok: false, error: string }
      expect(reply).toMatchObject({ ok: false })
      expect(reply.error).toContain(words)
    }

    it('refuses a revision that lowers a gate on an existing task', async () => {
      const gated = await t.createTask(slug, { humanReview: true, acceptanceCriteria: [{ text: 'A person checks it', checkedByHuman: true }, 'Tests pass'] })
      await t.db.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, gated.id))
      const kept = { ref: gated.ref, acceptanceCriteria: [{ text: 'A person checks it' }, { text: 'Tests pass' }] }
      await refused(plan({ ...kept, humanReview: false }), 'update_task')
      await refused(plan({ ...kept, humanReview: true, acceptanceCriteria: ['Tests pass'] }), 'update_task')
    })

    it('keeps the task\'s flag when a revision leaves it out', async () => {
      const gated = await t.createTask(slug, { humanReview: true })
      await t.db.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, gated.id))
      const saved = await call('propose_plan', plan({ ref: gated.ref, title: 'Reworded' }))
      expect(saved).toMatchObject({ ok: true })
      const [row] = await t.db.select().from(schema.planTasks).where(eq(schema.planTasks.taskId, gated.id))
      expect(row!.revision).toMatchObject({ humanReview: true })
    })

    it('checks again at approval, as the task may have gained a gate since', async () => {
      const open = await t.createTask(slug, { humanReview: false })
      await t.db.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, open.id))
      expect(await call('propose_plan', plan({ ref: open.ref, humanReview: false }))).toMatchObject({ ok: true })
      await t.db.update(tasks).set({ humanReview: true }).where(eq(tasks.id, open.id))
      const [row] = await t.db.select({ planId: schema.planTasks.planId }).from(schema.planTasks).where(eq(schema.planTasks.taskId, open.id))
      const approved = await t.request('POST', `/api/plan/plans/${row!.planId}/approve`, { to: 'backlog' })
      expect(approved.status).toBe(409)
      expect(await approved.json()).toMatchObject({ error: { code: 'plan_not_approvable', problems: [{ code: 'lowers_gate' }] } })
      expect(await statusOf(open.id)).toMatchObject({ humanReview: true })
    })

    it('refuses a lower review mode on an epic with live work', async () => {
      const live = { key: 'live', title: 'Live task', epic: 'e' }
      expect(await call('propose_plan', plan(live, [{ key: 'e', title: 'Live', summary: 's', reviewMode: 'epic' }]))).toMatchObject({ ok: true })
      await t.db.update(tasks).set({ status: 'backlog' }).where(and(eq(tasks.title, 'Live task'), eq(tasks.status, 'draft')))
      await refused(plan(live, [{ key: 'e', title: 'Live', summary: 's', reviewMode: 'direct' }]), 'update_parent')
    })
  })

  it('refuses a plan for another project in a project conversation', async () => {
    const other = await t.createProject()
    const reply = await call('propose_plan', { project: other.slug, title: 'Elsewhere', summary: 'x', tasks: [{ key: 'a', title: 'A', description: 'd', type: 'task', acceptanceCriteria: ['c'] }] }) as { ok: false, error: string }
    expect(reply).toMatchObject({ ok: false })
    expect(reply.error).toContain(`Start a thread in ${other.slug}`)
  })

  it('refuses to answer a task that is not Blocked', async () => {
    const failed = await task({ status: 'failed', statusReason: 'The run failed' })
    expect(await call('act_on_inbox', { taskRef: failed.ref, action: 'clarify', text: 'Try again' })).toMatchObject({ ok: false })
    expect(await statusOf(failed.id)).toMatchObject({ status: 'failed' })
    expect(await t.db.select().from(comments).where(eq(comments.taskId, failed.id))).toEqual([])
  })

  it('acts on an Inbox item in another project', async () => {
    const other = await t.createProject()
    await t.request('PATCH', `/api/projects/${other.slug}`, { paused: true })
    const elsewhere = await t.createTask(other.slug)
    await t.db.update(tasks).set({ status: 'blocked', statusReason: 'Which provider?' }).where(eq(tasks.id, elsewhere.id))
    await t.db.insert(auditLog).values({ taskId: elsewhere.id, projectId: other.id, actor: { kind: 'system', component: 'server' }, action: 'task.transition', detail: { event: 'stuck', from: 'in_progress', to: 'blocked' } })
    expect(await call('act_on_inbox', { taskRef: elsewhere.ref, action: 'clarify', text: 'Yes' })).toMatchObject({ ok: true })
    const [entry] = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, elsewhere.id), eq(auditLog.action, 'pm.tool_called')))
    expect(entry!.projectId).toBe(other.id)
  })

  it('retries a stopped task only through a confirm card', async () => {
    const stopped = await task({ status: 'agent_review', retryStop: { ...STOP, status: 'agent_review' } })
    const retried = await propose('act_on_inbox', { taskRef: stopped.ref, action: 'retry' })
    expect(retried.summary).toContain(`Retry ${stopped.ref}`)
    expect(await statusOf(stopped.id)).toMatchObject({ status: 'agent_review', retryStop: expect.anything() })
    expect(await (await resolve(retried.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect(await statusOf(stopped.id)).toMatchObject({ status: 'agent_review', retryStop: null })

    const running = await task({ status: 'in_progress' })
    expect(await call('act_on_inbox', { taskRef: running.ref, action: 'retry' })).toMatchObject({ ok: false })
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
    const review = await task({ status: 'human_review', prNumber: 7, prUrl: 'https://github.com/cormacrw/test-app/pull/7', headSha: 'a'.repeat(40) })
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
      expect(await (await resolve(failed.actionId, 'confirm')).json()).toMatchObject({ pendingAction: { status: 'failed', error: 'conflict: pm paused' } })
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
