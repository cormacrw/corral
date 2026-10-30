import type { Project } from '@corral/contracts'
import type { TaskPriority } from '@corral/core'
import { schema } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimNextTask, PLACE_BATCH, type Place } from './claim.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const { agents, auditLog, runs, tasks } = schema

describe.each(['pglite', 'postgres'] as const)('claimNextTask on %s', (driver) => {
  let t: TestApp

  // A failed assertion must not leave claimable tasks for the next test.
  beforeEach(async () => {
    t = await createTestApp(driver)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await t?.close()
  })

  let agentCount = 0
  async function developer(concurrency = 1, overrides: Partial<typeof agents.$inferInsert> = {}) {
    agentCount++
    const [agent] = await t.db.insert(agents)
      .values({ name: `Atlas ${driver} ${agentCount}`, role: 'developer', concurrency, ...overrides })
      .returning()
    return agent!.id
  }

  async function projectWithReadyTasks(count: number, priorities: TaskPriority[] = []): Promise<Project> {
    const project = await t.createProject()
    for (let i = 0; i < count; i++) {
      await t.createTask(project.slug, { priority: priorities[i] ?? 'medium' })
      await t.request('POST', `/api/projects/${project.slug}/tasks/${i + 1}/transitions`, { type: 'approve' })
    }
    return project
  }

  async function taskRow(project: Project, number: number) {
    const [row] = await t.db.select().from(tasks).where(and(eq(tasks.projectId, project.id), eq(tasks.number, number)))
    return row!
  }

  it('moves a Ready task to In progress with a lease, a run and an audit entry', async () => {
    const project = await projectWithReadyTasks(1)
    const agentId = await developer()
    const now = new Date('2026-10-27T12:00:00Z')

    const claim = await claimNextTask(t.db, agentId, now)
    const task = await taskRow(project, 1)
    expect(claim).toMatchObject({ taskId: task.id, leaseEpoch: 1, status: 'in_progress' })
    expect(task).toMatchObject({
      status: 'in_progress',
      leaseEpoch: 1,
      leaseRunId: claim!.runId,
      leaseRole: 'developer',
      leaseExpiresAt: new Date('2026-10-27T12:15:00Z')
    })

    const [run] = await t.db.select().from(runs).where(eq(runs.id, claim!.runId))
    expect(run).toMatchObject({ agentId, taskId: task.id, state: 'queued', leaseEpoch: 1 })

    const [audit] = await t.db.select().from(auditLog)
      .where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.claimed')))
    expect(audit).toMatchObject({ actor: { kind: 'system', component: 'scheduler' }, detail: { from: 'ready', to: 'in_progress', leaseEpoch: 1 } })
  })

  it('exposes the second developer holding the lease in API tasks and live updates', async () => {
    const project = await projectWithReadyTasks(1)
    // Atlas is the first developer seeded by createTestApp.
    const agentId = await developer(1, { runtime: 'codex' })
    const claim = await claimNextTask(t.db, agentId)
    const expected = { agentId, runId: claim!.runId, role: 'developer' }
    const path = `/api/projects/${project.slug}/tasks`
    const detail = await t.request('GET', `${path}/1`)
    expect(await detail.json()).toMatchObject({ lease: expected })
    const list = await t.request('GET', path)
    expect(await list.json()).toMatchObject([{ lease: expected }])
    t.events.length = 0
    await t.request('PATCH', `${path}/1`, { title: 'Leased by the second developer' })
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'task.updated', task: expect.objectContaining({ lease: expect.objectContaining(expected) }) }))
  })

  it('lets a Codex developer added through the API claim Ready tasks like Atlas', async () => {
    vi.spyOn(t.runner, 'detectClis').mockResolvedValue({ kind: 'detect_clis', clis: [
      { id: 'claude', version: '2.1.312', signedIn: true },
      { id: 'codex', version: '0.165.0', signedIn: true }
    ] } as never)
    const res = await t.request('POST', '/api/agents', { name: `Orion ${driver}`, role: 'developer', runtime: 'codex', concurrency: 1 })
    vi.restoreAllMocks()
    expect(res.status).toBe(201)
    const { id: agentId } = await res.json() as { id: string }
    const project = await projectWithReadyTasks(2)

    const claim = await claimNextTask(t.db, agentId)
    expect(claim).toMatchObject({ taskId: (await taskRow(project, 1)).id, leaseEpoch: 1, status: 'in_progress' })
    const [run] = await t.db.select().from(runs).where(eq(runs.id, claim!.runId))
    expect(run).toMatchObject({ agentId, role: 'developer', state: 'queued' })
    // Its concurrency limit applies like any other agent's
    expect(await claimNextTask(t.db, agentId)).toBeNull()
  })

  async function recordedReview(task: { id: string, projectId: string }, round: number, headSha: string, verdict: 'approved' | 'changes_requested') {
    const agentId = await developer(2, { role: 'reviewer' })
    const [run] = await t.db.insert(runs).values({ agentId, projectId: task.projectId, taskId: task.id, role: 'reviewer', state: 'completed', leaseEpoch: 1 }).returning()
    await t.db.insert(schema.reviews).values({ taskId: task.id, runId: run!.id, round, headSha, verdict, summary: 'Recorded verdict', author: t.actor })
    return agentId
  }

  it.each(['changes_requested', 'approved'] as const)('ignores an earlier-round %s verdict on the same commit, including already stranded tasks', async (verdict) => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    // Persisted pre-fix state: no transition or resubmission is needed to recover.
    await t.db.update(tasks).set({ status: 'agent_review', headSha: 'same-head', reviewRounds: 1 }).where(eq(tasks.id, task.id))
    const reviewer = await recordedReview(task, 0, 'same-head', verdict)
    expect(await claimNextTask(t.db, reviewer)).toMatchObject({ taskId: task.id, status: 'agent_review' })
  })

  it.each(['changes_requested', 'approved'] as const)('does not repeat a current-round %s verdict on the current commit', async (verdict) => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'agent_review', headSha: 'same-head', reviewRounds: 2 }).where(eq(tasks.id, task.id))
    const reviewer = await recordedReview(task, 2, 'same-head', verdict)

    expect(await claimNextTask(t.db, reviewer)).toBeNull()
    expect((await taskRow(project, task.number)).leaseRunId).toBeNull()
  })

  it('reviews a new commit even when the round already has a verdict on the old commit', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'agent_review', headSha: 'new-head', reviewRounds: 2 }).where(eq(tasks.id, task.id))
    const reviewer = await recordedReview(task, 2, 'old-head', 'approved')

    expect(await claimNextTask(t.db, reviewer)).toMatchObject({ taskId: task.id })
  })

  it('finds nothing when only Backlog tasks exist', async () => {
    const project = await t.createProject()
    await t.createTask(project.slug)
    expect(await claimNextTask(t.db, await developer())).toBeNull()
  })

  it('waits until every dependency is Merged', async () => {
    const project = await t.createProject()
    await t.createTask(project.slug)
    await t.createTask(project.slug, { dependsOn: [1] })
    await t.request('POST', `/api/projects/${project.slug}/tasks/2/transitions`, { type: 'approve' })
    const agentId = await developer(5)

    expect(await claimNextTask(t.db, agentId)).toBeNull()
    await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, (await taskRow(project, 1)).id))
    expect((await claimNextTask(t.db, agentId))?.taskId).toBe((await taskRow(project, 2)).id)
  })

  it('skips paused projects and paused tasks', async () => {
    const paused = await projectWithReadyTasks(1)
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, paused.id))
    const project = await projectWithReadyTasks(1)
    await t.db.update(tasks).set({ paused: true }).where(eq(tasks.id, (await taskRow(project, 1)).id))
    expect(await claimNextTask(t.db, await developer())).toBeNull()
  })

  it('takes urgent work first', async () => {
    const project = await projectWithReadyTasks(3, ['low', 'urgent', 'medium'])
    const claim = await claimNextTask(t.db, await developer())
    expect(claim?.taskId).toBe((await taskRow(project, 2)).id)
  })

  it('stops at the agent’s concurrency limit', async () => {
    await projectWithReadyTasks(2)
    const agentId = await developer(1)
    expect(await claimNextTask(t.db, agentId)).not.toBeNull()
    expect(await claimNextTask(t.db, agentId)).toBeNull()
  })

  it('claims nothing for a paused agent or one waiting on a usage limit (D3)', async () => {
    await projectWithReadyTasks(1)
    const now = new Date('2026-10-27T12:00:00Z')
    expect(await claimNextTask(t.db, await developer(1, { paused: true }), now)).toBeNull()
    expect(await claimNextTask(t.db, await developer(1, { pausedUntil: new Date('2026-10-27T15:00:00Z') }), now)).toBeNull()
    expect(await claimNextTask(t.db, await developer(1, { pausedUntil: new Date('2026-10-27T11:00:00Z') }), now)).not.toBeNull()
  })

  it('keeps looking past a full batch of tasks no runner can take', async () => {
    // The runnable task is low priority; more urgent tasks than one batch
    // holds wait ahead of it for a runner that isn't there
    const project = await projectWithReadyTasks(1, ['low'])
    const runnable = await taskRow(project, 1)
    const blocked = PLACE_BATCH + 3
    await t.db.insert(tasks).values(Array.from({ length: blocked }, (_, i) => ({
      projectId: project.id, number: i + 2, title: `Waiting ${i + 2}`, type: runnable.type, status: 'ready' as const, priority: 'urgent' as const, createdBy: runnable.createdBy
    })))
    const tried: string[] = []
    const place: Place = async (_tx, task) => {
      tried.push(task.id)
      return task.id === runnable.id ? 'runner-b' : null
    }

    const claim = await claimNextTask(t.db, await developer(), new Date(), undefined, [], place)
    expect(claim).toMatchObject({ taskId: runnable.id, runnerId: 'runner-b' })
    expect(new Set(tried).size).toBe(blocked + 1)
    expect((await taskRow(project, 2)).leaseRunId).toBeNull()
  })

  it('gives an In progress task with no lease a new lease and a higher epoch', async () => {
    await projectWithReadyTasks(1)
    const first = await claimNextTask(t.db, await developer())
    // The run ends, e.g. changes were requested: the task stays In progress, unleased (D10)
    await t.db.update(runs).set({ state: 'completed' }).where(eq(runs.id, first!.runId))
    await t.db.update(tasks).set({ leaseRunId: null, leaseRole: null, leaseExpiresAt: null }).where(eq(tasks.id, first!.taskId))

    const second = await claimNextTask(t.db, await developer())
    expect(second).toMatchObject({ taskId: first!.taskId, leaseEpoch: 2, status: 'in_progress' })
  })
})

// PGlite runs one transaction at a time, so these only prove anything on
// Postgres (D14). They're the PRD's Phase 1 exit criterion.
describe('concurrent claims on postgres', () => {
  let t: TestApp

  beforeEach(async () => {
    t = await createTestApp('postgres')
  })

  afterEach(async () => {
    await t?.close()
  })

  async function readyTasks(count: number) {
    const project = await t.createProject()
    for (let i = 1; i <= count; i++) {
      await t.createTask(project.slug)
      await t.request('POST', `/api/projects/${project.slug}/tasks/${i}/transitions`, { type: 'approve' })
    }
    return project
  }

  it('never gives one task to two claims', async () => {
    const project = await readyTasks(10)
    const agentIds = await Promise.all([1, 2, 3, 4, 5].map(async (i) => {
      const [agent] = await t.db.insert(agents).values({ name: `Atlas race ${i}`, role: 'developer', concurrency: 10 }).returning()
      return agent!.id
    }))

    // 40 claims race for 10 tasks
    const claims = await Promise.all(Array.from({ length: 40 }, (_, i) => claimNextTask(t.db, agentIds[i % 5]!)))
    const won = claims.filter(c => c !== null)

    expect(won).toHaveLength(10)
    expect(new Set(won.map(c => c.taskId)).size).toBe(10)
    const rows = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
    expect(rows.every(r => r.status === 'in_progress' && r.leaseEpoch === 1)).toBe(true)
    expect(await t.db.$count(runs, eq(runs.projectId, project.id))).toBe(10)
  })

  it('never exceeds an agent’s concurrency limit', async () => {
    await readyTasks(10)
    const [agent] = await t.db.insert(agents).values({ name: 'Atlas capped', role: 'developer', concurrency: 3 }).returning()

    const claims = await Promise.all(Array.from({ length: 10 }, () => claimNextTask(t.db, agent!.id)))
    expect(claims.filter(c => c !== null)).toHaveLength(3)
  })
})
