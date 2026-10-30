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

  it('clears a waiting PM job when a turn ends', () => {
    expect(runEndValues({ state: 'failed', outcome: 'failed', error: 'x' }, new Date(0))).toMatchObject({ pmJob: null, endedAt: new Date(0), outcome: 'failed', error: 'x' })
  })
})
