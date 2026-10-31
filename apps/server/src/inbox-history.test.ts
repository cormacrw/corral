import type { Inbox } from '@corral/contracts'
import { schema } from '@corral/db'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const { auditLog, tasks } = schema

// Audit rows as past versions stored them, inserted raw on purpose: the Inbox
// has to keep reading them the same way, and reading must leave them alone.
describe('inbox over stored audit rows', () => {
  let t: TestApp
  const now = new Date('2026-10-30T09:00:00.000Z').getTime()
  const at = (minutes: number) => new Date(now - minutes * 60_000)
  const system = { kind: 'system', component: 'server' } as const

  beforeAll(async () => {
    t = await createTestApp('pglite')
  })

  afterAll(async () => {
    await t?.close()
  })

  const inbox = async () => t.request('GET', '/api/inbox').then(r => r.json()) as Promise<Inbox>

  it('shows the same activity, resolutions and arrival times for string and object events', async () => {
    const project = await t.createProject({ name: 'History', prefix: 'HIS', repository: 'cormacrw/test-app', defaultBranch: 'main' })
    const paused = await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    expect(paused.status).toBe(200)
    const task = async (title: string, set: Partial<typeof tasks.$inferInsert> = {}) => {
      const created = await t.createTask(project.slug, { title })
      await t.db.update(tasks).set({ updatedAt: at(0), ...set }).where(eq(tasks.id, created.id))
      return created.id
    }
    const row = (taskId: string, minutes: number, detail: Record<string, unknown>, action = 'task.transition', actor: typeof auditLog.$inferInsert['actor'] = system) =>
      ({ projectId: project.id, taskId, actor, action, detail, createdAt: at(minutes) })

    const stuck = await task('Stuck', { status: 'blocked', statusReason: 'Which API?' })
    const blocked = await task('Blocked', { status: 'blocked', statusReason: 'Reset' })
    const objectEvent = await task('Object event', { status: 'human_review' })
    const stringEvent = await task('String event', { status: 'failed', statusReason: 'Gave up' })
    const moved = await task('Activity', { prNumber: 7, type: 'design' })
    const human = await task('Resolved')
    const prFree = await task('PR-free')
    const withPr = await task('With a PR', { prNumber: 8 })

    await t.db.insert(auditLog).values([
      row(stuck, 50, { event: 'stuck', runId: 'r', from: 'in_progress', to: 'blocked' }),
      // A human moving a task writes the input as the event. Blocked again later, so the later entry counts
      row(blocked, 60, { event: 'blocked', from: 'in_progress', to: 'blocked' }),
      row(blocked, 40, { event: { type: 'resolve', to: 'in_progress' }, from: 'blocked', to: 'in_progress' }),
      row(blocked, 30, { event: 'dependency_deleted', dependency: 'HIS-1', from: 'in_progress', to: 'blocked' }),
      row(objectEvent, 25, { event: { type: 'approve' }, from: 'agent_review', to: 'human_review' }),
      row(objectEvent, 5, { event: 'head_moved', from: 'human_review', to: 'human_review' }),
      row(stringEvent, 20, { event: 'merge_failed', from: 'ready_to_merge', to: 'failed' }),

      row(moved, 19, { event: 'pr_opened', from: 'in_progress', to: 'agent_review' }),
      row(moved, 18, { event: { type: 'pr_updated' }, from: 'in_progress', to: 'agent_review' }),
      row(moved, 17, { event: 'changes_requested', from: 'agent_review', to: 'blocked' }),
      row(moved, 16, { event: 'changes_requested', from: 'agent_review', to: 'in_progress' }),
      row(moved, 15, { event: 'design_submitted', version: 2, from: 'in_progress', to: 'agent_review' }),
      row(moved, 14, { verdict: 'approved', met: 2, of: 3 }, 'review.recorded'),
      row(moved, 13, { verdict: 'changes_requested', met: 1, of: 3 }, 'review.recorded'),
      row(moved, 12, { event: 'review_approved', from: 'agent_review', to: 'ready_to_merge' }),

      row(prFree, 2.8, { event: 'ci_failed', checks: [], from: 'ready_to_merge', to: 'in_progress' }),
      row(prFree, 2.7, { event: 'base_conflict', from: 'ready_to_merge', to: 'in_progress' }),
      row(prFree, 2.6, { event: 'head_moved', from: 'ready_to_merge', to: 'agent_review' }),
      row(withPr, 2.5, { event: 'ci_failed', checks: [], from: 'ready_to_merge', to: 'in_progress' }),
      row(withPr, 2.4, { event: 'base_conflict', from: 'ready_to_merge', to: 'in_progress' }),
      row(withPr, 2.3, { event: 'head_moved', from: 'ready_to_merge', to: 'agent_review' }),

      row(human, 11, { event: { type: 'resolve', to: 'ready' }, from: 'blocked', to: 'ready' }, 'task.transition', t.actor),
      row(human, 10, { event: 'resolve', from: 'blocked', to: 'in_progress' }, 'task.transition', t.actor),
      row(human, 9, { event: { type: 'resolve', to: 'backlog' } }, 'task.transition', t.actor),
      row(human, 8, { event: 'resolve' }, 'task.transition', t.actor),
      row(human, 7, { event: { type: 'human_request_changes', feedback: 'No' }, from: 'human_review', to: 'in_progress' }, 'task.transition', t.actor),
      row(human, 6, { event: 'human_approve', from: 'human_review', to: 'ready_to_merge' }, 'task.transition', t.actor),
      row(human, 4, { event: { type: 'send_back' }, from: 'ready', to: 'backlog' }, 'task.transition', t.actor),
      row(human, 3, { mode: 'soft' }, 'task.deleted', t.actor)
    ])
    const stored = await t.db.select().from(auditLog).orderBy(asc(auditLog.id))

    const { needsYou, activity, resolved } = await inbox()
    const mine = <T extends { project?: { id: string } | null }>(items: T[]) => items.filter(i => i.project?.id === project.id)
    expect(mine(needsYou).map(i => [i.subject, 'type' in i ? i.type : null, i.at])).toEqual([
      ['String event', 'failed', at(20).toISOString()],
      ['Object event', 'human_review', at(25).toISOString()],
      ['Blocked', 'blocked', at(30).toISOString()],
      ['Stuck', 'question', at(50).toISOString()]
    ])
    expect(mine(activity).map(i => [i.body, i.at])).toEqual([
      ['New commits on PR #8; back to the reviewer', at(2.3).toISOString()],
      ['PR #8 conflicts with the base branch; back to the developer', at(2.4).toISOString()],
      ['CI failed on PR #8; back to the developer', at(2.5).toISOString()],
      ['New commits on the task branch; back to the reviewer', at(2.6).toISOString()],
      ['The commit conflicts with the epic branch; back to the developer', at(2.7).toISOString()],
      ['CI failed on the commit; back to the developer', at(2.8).toISOString()],
      ['New commits on the task branch; back to the reviewer', at(5).toISOString()],
      ['Requested changes on PR #7 (1 of 3 criteria met)', at(13).toISOString()],
      ['Approved PR #7 (2 of 3 criteria met)', at(14).toISOString()],
      ['Submitted design v2; on to the reviewer', at(15).toISOString()],
      ['Changes requested; back to the developer', at(16).toISOString()],
      ['Changes requested; Blocked for you', at(17).toISOString()],
      ['Pushed a revision to PR #7', at(18).toISOString()],
      ['Opened PR #7', at(19).toISOString()]
    ])
    expect(mine(resolved).map(i => [i.resolution, i.at])).toEqual([
      ['You deleted the task', at(3).toISOString()],
      ['You sent the task back to Backlog', at(4).toISOString()],
      ['You approved the merge', at(6).toISOString()],
      ['You requested changes', at(7).toISOString()],
      ['You moved the task to a new status', at(8).toISOString()],
      ['You moved the task to backlog', at(9).toISOString()],
      ['You moved the task to in progress', at(10).toISOString()],
      ['You moved the task to ready', at(11).toISOString()]
    ])

    expect(await t.db.select().from(auditLog).orderBy(asc(auditLog.id))).toEqual(stored)
  })
})
