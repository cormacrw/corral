import type { Inbox, InboxActionInput } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyTransition, lockTask } from './tasks.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const { auditLog, deployments, epics, planMessages, planSessions, runs, tasks } = schema
const server = { kind: 'system', component: 'server' } as const

// D11: Needs you and every badge hold unresolved decisions, nothing else
describe('the actionable Inbox', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp('pglite')
  })

  afterAll(async () => {
    await t?.close()
  })

  const inbox = async () => t.request('GET', '/api/inbox').then(r => r.json()) as Promise<Inbox>
  const mine = async (projectId: string) => (await inbox()).needsYou.filter(i => i.project.id === projectId)
  const act = async (id: string, input: InboxActionInput) => t.request('POST', `/api/inbox/${id}/actions`, input)
  async function failRun(id: string) {
    await t.db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, id)
      await applyTransition(tx, task, project, { type: 'run_failed' }, server, { event: 'run_failed', runId: crypto.randomUUID(), error: 'exit 1' })
    })
  }
  async function reviewEpic(projectId: string, reviewState: 'human_review' | 'conflict') {
    const [epic] = await t.db.insert(epics).values({ projectId, title: 'Feature', createdBy: t.actor, reviewMode: 'epic', branch: 'corral/epic', prNumber: 7, prHeadSha: 'head', reviewState, conflictFiles: reviewState === 'conflict' ? ['a.ts'] : null }).returning()
    return epic!
  }

  it('adds neither a row nor a count for routine replies and deployments, and keeps both reachable', async () => {
    const project = await t.createProject()
    const before = await inbox()
    const [session] = await t.db.insert(planSessions).values({ projectId: project.id, title: 'Chat', createdBy: t.actor, unread: true }).returning()
    await t.db.insert(planMessages).values({ sessionId: session!.id, role: 'pm', kind: 'message', text: 'All done.' })
    const [deployment] = await t.db.insert(deployments).values({ projectId: project.id, toSha: 'a'.repeat(40), notes: 'Shipped', notesStatus: 'ready' }).returning()

    const after = await inbox()
    expect(await mine(project.id)).toEqual([])
    expect(after.count).toBe(before.count)
    expect(after.activity.find(i => i.id === deployment!.id)).toMatchObject({ type: 'release_notes', notes: 'Shipped', unread: true })
    const detail = await t.request('GET', `/api/plan/sessions/${session!.id}`).then(r => r.json()) as { status: string, unread: boolean, messages: { text: string }[] }
    expect(detail).toMatchObject({ status: 'none', unread: true, messages: [{ text: 'All done.' }] })
  })

  it('stays quiet while runs fail below the cap, then holds one decision until it is resolved', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, task.id))
    const [{ failedRunCap }] = await t.db.select({ failedRunCap: schema.projects.failedRunCap }).from(schema.projects).where(eq(schema.projects.id, project.id)) as [{ failedRunCap: number }]
    for (let i = 1; i < failedRunCap; i++) {
      await failRun(task.id)
      expect(await mine(project.id)).toEqual([])
    }
    await failRun(task.id)
    expect(await mine(project.id)).toEqual([expect.objectContaining({ type: 'failed', body: `Failed-run cap reached (${failedRunCap})` })])
    // Reading or commenting doesn't resolve it
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/comments`, { body: 'Looking' })
    expect(await mine(project.id)).toHaveLength(1)

    expect((await act(task.id, { action: 'resolve', to: 'ready' })).status).toBe(200)
    expect(await mine(project.id)).toEqual([])
  })

  it('shows an epic awaiting approval once, with its integrated tasks and internal events in Activity only', async () => {
    const project = await t.createProject()
    const epic = await reviewEpic(project.id, 'human_review')
    const first = await t.createTask(project.slug, { title: 'One' })
    const second = await t.createTask(project.slug, { title: 'Two' })
    await t.db.update(tasks).set({ status: 'merged', epicId: epic.id }).where(eq(tasks.id, first.id))
    await t.db.update(tasks).set({ status: 'merged', epicId: epic.id }).where(eq(tasks.id, second.id))
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
    await t.db.insert(runs).values({ projectId: project.id, epicId: epic.id, agentId: agent!.id, role: 'reviewer', state: 'completed', outcome: 'approved', summary: 'Good', endedAt: new Date() })
    await t.db.insert(auditLog).values([
      { projectId: project.id, taskId: first.id, actor: server, action: 'task.transition', detail: { event: 'integrated', from: 'ready_to_merge', to: 'merged', integratedCommitSha: 'c0ffee' } },
      { projectId: project.id, taskId: first.id, actor: server, action: 'review.recorded', detail: { verdict: 'approved', met: 1, of: 1 } }
    ])

    expect((await mine(project.id)).map(i => [i.type, i.id])).toEqual([['epic_review', epic.id]])
    const { activity } = await inbox()
    expect(activity.filter(i => i.taskId === first.id).map(i => i.type)).toEqual(['activity', 'activity'])
  })

  it('shows one recovery decision for an epic whose review gave up, or that conflicts', async () => {
    const project = await t.createProject()
    const gaveUp = await reviewEpic(project.id, 'human_review')
    const done = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'merged', epicId: gaveUp.id }).where(eq(tasks.id, done.id))
    await t.db.insert(auditLog).values({ projectId: project.id, actor: server, action: 'epic.pr', detail: { epicId: gaveUp.id, event: 'review_failed', headSha: 'head', summary: 'Stopped after 3 failures' } })
    const conflict = await reviewEpic(project.id, 'conflict')
    const items = await mine(project.id)
    expect(items.map(i => i.id).sort()).toEqual([gaveUp.id, conflict.id].sort())
    expect(items.find(i => i.id === gaveUp.id)).toMatchObject({ type: 'epic_review', body: 'Stopped after 3 failures' })
    expect(items.find(i => i.id === conflict.id)).toMatchObject({ type: 'epic_conflict' })
  })

  it('keeps reviews a human must give: a standalone review, a design, a spike and a human check', async () => {
    const project = await t.createProject()
    const standalone = await t.createTask(project.slug, { title: 'Standalone', humanReview: true })
    const design = await t.createTask(project.slug, { title: 'Design', type: 'design' })
    const spike = await t.createTask(project.slug, { title: 'Spike', type: 'spike' })
    const checked = await t.createTask(project.slug, { title: 'Checked', acceptanceCriteria: [{ text: 'Feels right', checkedByHuman: true }] })
    for (const { id } of [standalone, design, spike, checked]) await t.db.update(tasks).set({ status: 'human_review' }).where(eq(tasks.id, id))

    const items = await mine(project.id)
    expect(items.map(i => i.subject).sort()).toEqual(['Checked', 'Design', 'Spike', 'Standalone'])
    expect(items.every(i => i.type === 'human_review')).toBe(true)
    expect(items.find(i => i.subject === 'Checked')).toMatchObject({ body: expect.stringContaining('need your OK') })
  })

  it('counts exactly what it lists', async () => {
    const box = await inbox()
    expect(box.count).toBe(box.needsYou.length)
    expect(box.needsYou.some(i => (i.type as string) === 'release_notes')).toBe(false)
  })
})
