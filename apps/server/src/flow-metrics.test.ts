import type { FlowMetrics } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flowMetrics, percentiles } from './flow-metrics.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const hour = 3_600_000
const now = new Date()
const at = (hours: number) => new Date(now.getTime() + hours * hour)

describe.each(['pglite', 'postgres'] as const)('flow metrics on %s', (driver) => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp(driver)
  })
  afterAll(async () => {
    await t?.close()
  })

  it('aggregates lifetime status visits and runs for only the project/window cohort', async () => {
    const p = await t.createProject()
    const other = await t.createProject()
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'developer'))
    const seed = async (projectId: string, number: number, mergedHours: number, extra = {}) => {
      const [task] = await t.db.insert(schema.tasks).values({ projectId, number, createdBy: t.actor, title: 'Flow sample', description: {}, type: 'task', status: 'merged', createdAt: at(mergedHours - 100), mergedAt: at(mergedHours), ...extra }).returning()
      return task!
    }
    const one = await seed(p.id, 1, -1)
    const two = await seed(p.id, 2, -2, { createdAt: at(-52) })
    // Older creation is allowed; older merge, future merge, deletion and other projects are not.
    await seed(p.id, 3, -24 * 8)
    await seed(p.id, 4, 1)
    await seed(p.id, 5, -1, { deletedAt: at(0) })
    await seed(other.id, 1, -1)
    const transition = (taskId: string, from: string, to: string, hours: number) => ({ projectId: p.id, taskId, actor: t.actor, action: 'task.transition', detail: { from, to }, createdAt: at(hours) })
    await t.db.insert(schema.auditLog).values([
      transition(one.id, 'backlog', 'ready', -91),
      transition(one.id, 'ready', 'in_progress', -81),
      transition(one.id, 'in_progress', 'agent_review', -71),
      transition(one.id, 'agent_review', 'in_progress', -66),
      transition(one.id, 'in_progress', 'human_review', -61),
      transition(one.id, 'human_review', 'human_review', -51),
      transition(one.id, 'human_review', 'ready_to_merge', -11),
      transition(one.id, 'ready_to_merge', 'merged', -1),
      transition(two.id, 'ready', 'in_progress', -42),
      transition(two.id, 'in_progress', 'human_review', -32),
      transition(two.id, 'human_review', 'merged', -2)
    ])
    await t.db.insert(schema.runs).values([
      { projectId: p.id, taskId: one.id, agentId: agent!.id, role: 'developer', queuedAt: at(-81), startedAt: at(-80), endedAt: at(-74) },
      { projectId: p.id, taskId: one.id, agentId: agent!.id, role: 'developer', queuedAt: at(-66), startedAt: at(-63), endedAt: at(-61) },
      { projectId: p.id, taskId: two.id, agentId: agent!.id, role: 'reviewer', queuedAt: at(-32), startedAt: at(-30), endedAt: at(-29) },
      // Missing timestamps don't invent zero-duration samples.
      { projectId: p.id, taskId: two.id, agentId: agent!.id, role: 'developer', queuedAt: at(-42) },
      // Runs queued after the merge are not part of the task's delivery.
      { projectId: p.id, taskId: one.id, agentId: agent!.id, role: 'developer', queuedAt: at(0) }
    ])
    const result = await flowMetrics(t.db, p, '7d', now)
    const response = await t.request('GET', `/api/projects/${p.slug}/metrics/flow?window=7d`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
    expect(result.mergedTaskCount).toBe(2)
    expect(result.leadTime).toEqual({ medianMs: 75 * hour, p90Ms: 95 * hour })
    expect(result.cycleTime).toEqual({ medianMs: 60 * hour, p90Ms: 76 * hour })
    expect(result.timeInStatus).toEqual(expect.arrayContaining([
      { status: 'human_review', medianMs: 40 * hour, p90Ms: 48 * hour },
      { status: 'in_progress', medianMs: 12.5 * hour, p90Ms: 14.5 * hour }
    ]))
    expect(result.runsByRole).toEqual([
      { role: 'developer', queueWait: { medianMs: 2 * hour, p90Ms: 2.8 * hour }, duration: { medianMs: 4 * hour, p90Ms: 5.6 * hour } },
      { role: 'reviewer', queueWait: { medianMs: 2 * hour, p90Ms: 2 * hour }, duration: { medianMs: hour, p90Ms: hour } }
    ])
    expect(result.averageDeveloperRuns).toBe(1.5)
    expect(result.slowestTasks).toEqual([
      { ref: `${p.prefix}-1`, leadTimeMs: 100 * hour, dominantStatus: 'human_review' },
      { ref: `${p.prefix}-2`, leadTimeMs: 50 * hour, dominantStatus: 'human_review' }
    ])
    expect((await flowMetrics(t.db, p, '30d', now)).mergedTaskCount).toBe(3)
    expect((await flowMetrics(t.db, p, '90d', now)).mergedTaskCount).toBe(3)
  })

  it('returns the slowest ten, includes the lower boundary, and handles absent histories', async () => {
    const p = await t.createProject()
    await t.db.insert(schema.tasks).values(Array.from({ length: 12 }, (_, i) => ({ projectId: p.id, number: i + 1, createdBy: t.actor, title: 'Historical task', type: 'task' as const, status: 'merged' as const, createdAt: at(-168 - i - 1), mergedAt: at(-168) })))
    const result = await flowMetrics(t.db, p, '7d', now)
    expect(result.mergedTaskCount).toBe(12)
    expect(result.cycleTime).toEqual({ medianMs: 0, p90Ms: 0 })
    expect(result.slowestTasks).toHaveLength(10)
    expect(result.slowestTasks.map(task => task.ref)).toEqual(Array.from({ length: 10 }, (_, i) => `${p.prefix}-${12 - i}`))
    expect(result.slowestTasks[0]).toMatchObject({ dominantStatus: 'backlog', leadTimeMs: 12 * hour })
  })

  it('keeps the completed duration of a reviewer that ends just after a spike merges', async () => {
    const p = await t.createProject()
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
    const [task] = await t.db.insert(schema.tasks).values({ projectId: p.id, number: 1, createdBy: t.actor, title: 'Spike', type: 'spike', status: 'merged', createdAt: at(-3), mergedAt: at(-1) }).returning()
    await t.db.insert(schema.runs).values({ projectId: p.id, taskId: task!.id, agentId: agent!.id, role: 'reviewer', queuedAt: at(-2.5), startedAt: at(-2), endedAt: new Date(at(-1).getTime() + 100) })
    const result = await flowMetrics(t.db, p, '7d', now)
    expect(result.runsByRole).toEqual([{ role: 'reviewer', queueWait: { medianMs: 0.5 * hour, p90Ms: 0.5 * hour }, duration: { medianMs: hour + 100, p90Ms: hour + 100 } }])
  })

  it('serves zero/empty metrics and validates windows and project slugs', async () => {
    const p = await t.createProject()
    for (const window of ['7d', '30d', '90d', ''] as const) {
      const response = await t.request('GET', `/api/projects/${p.slug}/metrics/flow${window ? `?window=${window}` : ''}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ window: window || '30d', mergedTaskCount: 0, leadTime: { medianMs: 0, p90Ms: 0 }, cycleTime: { medianMs: 0, p90Ms: 0 }, timeInStatus: [], runsByRole: [], averageDeveloperRuns: 0, slowestTasks: [] } satisfies FlowMetrics)
    }
    expect((await t.request('GET', `/api/projects/${p.slug}/metrics/flow?window=1d`)).status).toBe(400)
    expect((await t.request('GET', '/api/projects/no-such-project/metrics/flow')).status).toBe(404)
  })
})

it('uses continuous percentiles for empty, singleton, odd and even samples', () => {
  expect(percentiles([])).toEqual({ medianMs: 0, p90Ms: 0 })
  expect(percentiles([5])).toEqual({ medianMs: 5, p90Ms: 5 })
  expect(percentiles([30, 10, 20])).toEqual({ medianMs: 20, p90Ms: 28 })
  expect(percentiles([10, 20])).toEqual({ medianMs: 15, p90Ms: 19 })
})
