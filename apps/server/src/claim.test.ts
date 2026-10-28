import type { Project } from '@corral/contracts'
import type { TaskPriority } from '@corral/core'
import { schema } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimNextTask } from './claim.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const { agents, auditLog, projects, runs, tasks } = schema

describe.each(['pglite', 'postgres'] as const)('claimNextTask on %s', (driver) => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp(driver)
  })

  afterAll(async () => {
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

  // A fresh project, so earlier tests' tasks can't be claimed
  async function projectWithReadyTasks(count: number, priorities: TaskPriority[] = []): Promise<Project> {
    const project = await t.createProject()
    for (let i = 0; i < count; i++) {
      await t.createTask(project.slug, { priority: priorities[i] ?? 'medium' })
      await t.request('POST', `/api/projects/${project.slug}/tasks/${i + 1}/transitions`, { type: 'approve' })
    }
    return project
  }

  // Every test pauses the projects it's done with, so they don't leak tasks
  async function pauseProject(project: Project) {
    await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
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
    await pauseProject(project)
  })

  it('finds nothing when only Backlog tasks exist', async () => {
    const project = await t.createProject()
    await t.createTask(project.slug)
    expect(await claimNextTask(t.db, await developer())).toBeNull()
    await pauseProject(project)
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
    await pauseProject(project)
  })

  it('skips paused projects and paused tasks', async () => {
    const paused = await projectWithReadyTasks(1)
    await pauseProject(paused)
    const project = await projectWithReadyTasks(1)
    await t.db.update(tasks).set({ paused: true }).where(eq(tasks.id, (await taskRow(project, 1)).id))
    expect(await claimNextTask(t.db, await developer())).toBeNull()
    await pauseProject(project)
  })

  it('takes urgent work first', async () => {
    const project = await projectWithReadyTasks(3, ['low', 'urgent', 'medium'])
    const claim = await claimNextTask(t.db, await developer())
    expect(claim?.taskId).toBe((await taskRow(project, 2)).id)
    await pauseProject(project)
  })

  it('stops at the agent’s concurrency limit', async () => {
    const project = await projectWithReadyTasks(2)
    const agentId = await developer(1)
    expect(await claimNextTask(t.db, agentId)).not.toBeNull()
    expect(await claimNextTask(t.db, agentId)).toBeNull()
    await pauseProject(project)
  })

  it('claims nothing for a paused agent or one waiting on a usage limit (D3)', async () => {
    const project = await projectWithReadyTasks(1)
    const now = new Date('2026-10-27T12:00:00Z')
    expect(await claimNextTask(t.db, await developer(1, { paused: true }), now)).toBeNull()
    expect(await claimNextTask(t.db, await developer(1, { pausedUntil: new Date('2026-10-27T15:00:00Z') }), now)).toBeNull()
    expect(await claimNextTask(t.db, await developer(1, { pausedUntil: new Date('2026-10-27T11:00:00Z') }), now)).not.toBeNull()
    await pauseProject(project)
  })

  it('gives an In progress task with no lease a new lease and a higher epoch', async () => {
    const project = await projectWithReadyTasks(1)
    const first = await claimNextTask(t.db, await developer())
    // The run ends, e.g. changes were requested: the task stays In progress, unleased (D10)
    await t.db.update(runs).set({ state: 'completed' }).where(eq(runs.id, first!.runId))
    await t.db.update(tasks).set({ leaseRunId: null, leaseRole: null, leaseExpiresAt: null }).where(eq(tasks.id, first!.taskId))

    const second = await claimNextTask(t.db, await developer())
    expect(second).toMatchObject({ taskId: first!.taskId, leaseEpoch: 2, status: 'in_progress' })
    await pauseProject(project)
  })
})

// PGlite runs one transaction at a time, so these only prove anything on
// Postgres (D14). They're the PRD's Phase 1 exit criterion.
describe('concurrent claims on postgres', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp('postgres')
  })

  afterAll(async () => {
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
    await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
  })

  it('never exceeds an agent’s concurrency limit', async () => {
    await readyTasks(10)
    const [agent] = await t.db.insert(agents).values({ name: 'Atlas capped', role: 'developer', concurrency: 3 }).returning()

    const claims = await Promise.all(Array.from({ length: 10 }, () => claimNextTask(t.db, agent!.id)))
    expect(claims.filter(c => c !== null)).toHaveLength(3)
  })
})
