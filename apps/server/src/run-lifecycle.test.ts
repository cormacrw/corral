import type { Run } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runEndValues } from './run-lifecycle.ts'
import { getRun, listRuns } from './runs.ts'
import { createTestApp, type TestApp } from './test-app.ts'

describe('run lifecycle', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp('pglite')
  })
  afterAll(() => t.close())

  async function ended(role: 'pm' | 'developer', end: Parameters<typeof runEndValues>[0]): Promise<Run> {
    const project = await t.createProject()
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, role)).limit(1)
    const task = role === 'pm' ? null : await t.createTask(project.slug)
    const [row] = await t.db.insert(schema.runs).values({ agentId: agent!.id, projectId: project.id, taskId: task?.id ?? null, role, state: 'running' }).returning()
    await t.db.update(schema.runs).set(runEndValues(end, new Date())).where(eq(schema.runs.id, row!.id))
    return getRun(t.db, row!.id)
  }

  it('saves and serves a finished PM turn with no outcome', async () => {
    const run = await ended('pm', { state: 'completed', summary: 'Here is the plan' })
    expect(run).toMatchObject({ role: 'pm', state: 'completed', outcome: null, summary: 'Here is the plan', endedAt: expect.any(String) })
    expect(await listRuns(t.db, { agentId: run.agentId })).toContainEqual(run)
  })

  it('saves and serves an interrupted run with no outcome', async () => {
    const run = await ended('developer', { state: 'interrupted', error: 'Stopped by a human' })
    expect(run).toMatchObject({ role: 'developer', state: 'interrupted', outcome: null, error: 'Stopped by a human', endedAt: expect.any(String) })
  })

  it('returns the complete active snapshot while keeping history and explicit limits bounded', async () => {
    const project = await t.createProject()
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer')).limit(1)
    const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, title: 'Integration review', createdBy: t.actor }).returning()
    await t.db.insert(schema.runs).values(Array.from({ length: 51 }, () => ({
      agentId: agent!.id, projectId: project.id, epicId: epic!.id, role: 'reviewer' as const, state: 'running' as const
    })))
    const active = await listRuns(t.db, { projectId: project.id, active: true })
    expect(active).toHaveLength(51)
    expect(active.every(run => run.epicId === epic!.id && run.taskId === null)).toBe(true)
    expect(await listRuns(t.db, { projectId: project.id })).toHaveLength(50)
    expect(await listRuns(t.db, { projectId: project.id, active: true }, 3)).toHaveLength(3)
  })

  it('publishes an interrupted epic run when its lease expires without a runner response', async () => {
    const project = await t.createProject()
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer')).limit(1)
    const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, title: 'Expired review', createdBy: t.actor }).returning()
    const [run] = await t.db.insert(schema.runs).values({
      agentId: agent!.id, projectId: project.id, epicId: epic!.id, role: 'reviewer', state: 'running',
      leaseExpiresAt: new Date(t.clock.now.getTime() - 1)
    }).returning()
    const before = t.events.length

    // No runner is connected, so there will be no run.ended acknowledgement.
    await t.orchestrator.sweepLeases()

    expect(t.events.slice(before)).toContainEqual({
      type: 'run.updated',
      run: expect.objectContaining({
        id: run!.id, epicId: epic!.id, taskId: null, state: 'interrupted',
        endedAt: t.clock.now.toISOString(), outcome: null, error: 'Epic review lease expired'
      })
    })
    expect(await listRuns(t.db, { projectId: project.id, active: true })).toEqual([])
  })

  it('clears a waiting PM job when a turn ends', () => {
    expect(runEndValues({ state: 'failed', outcome: 'failed', error: 'x' }, new Date(0))).toMatchObject({ pmJob: null, endedAt: new Date(0), outcome: 'failed', error: 'x' })
  })
})
