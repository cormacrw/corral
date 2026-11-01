import type { Inbox } from '@corral/contracts'
import { schema } from '@corral/db'
import { asc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAudit } from './audit.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const { auditLog, tasks, epics, deployments } = schema

// Audit rows as past versions stored them, inserted raw on purpose: the Inbox
// has to keep reading them the same way, and reading must leave them alone.
describe('inbox over stored audit rows', () => {
  let t: TestApp
  const now = new Date('2026-10-30T09:00:00.000Z').getTime()
  const at = (minutes: number) => new Date(now - minutes * 60_000)
  const system = { kind: 'system', component: 'server' } as const

  beforeEach(async () => {
    t = await createTestApp('pglite')
  })

  afterEach(async () => {
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
    const moved = await task('Activity', { prNumber: 7, prUrl: 'https://github.com/cormacrw/test-app/pull/7', type: 'design' })
    const human = await task('Resolved')
    const prFree = await task('PR-free')
    const withPr = await task('With a PR', { prNumber: 8, prUrl: 'https://github.com/cormacrw/test-app/pull/8' })

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

  it('reads every epic PR event without borrowing a task, preserving mixed history and live conflicts', async () => {
    const project = await t.createProject({ name: 'Epic history', prefix: 'EPH', repository: 'cormacrw/test-app', defaultBranch: 'main' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, title: 'Epic without tasks', createdBy: t.actor, prNumber: 12, prHeadSha: 'head', reviewState: 'conflict', conflictFiles: ['shared.ts'] }).returning()
    const events = ['opened', 'review_started', 'approved', 'changes_requested', 'rebase_requested', 'rebased', 'conflict', 'ci_failed', 'merge_refused', 'closed', 'merged', 'future_event']
    const actions = ['human_approved', 'human_changes_requested', 'rebase_handed_off']
    const inserted = await t.db.insert(auditLog).values([
      ...events.map((event, i) => ({ projectId: project.id, actor: system, action: 'epic.pr', detail: { epicId: epic!.id, event, summary: `Details for ${event}` }, createdAt: at(30 - i) })),
      ...actions.map((event, i) => ({ projectId: project.id, actor: t.actor, action: 'epic.pr', detail: { epicId: epic!.id, event, summary: `Human note for ${event}` }, createdAt: at(10 - i) }))
    ]).returning()
    const task = await t.createTask(project.slug, { title: 'Old task history' })
    const oldRows = await t.db.insert(auditLog).values([
      { projectId: project.id, taskId: task.id, actor: system, action: 'task.transition', detail: { event: { type: 'pr_opened' } }, createdAt: at(25.5) },
      { projectId: project.id, taskId: task.id, actor: t.actor, action: 'task.transition', detail: { event: { type: 'human_approve' } }, createdAt: at(9.5) }
    ]).returning()
    await t.db.insert(deployments).values({ projectId: project.id, toSha: 'abc123', notesStatus: 'ready', notes: 'Old release notes', dismissedAt: at(9.7), createdAt: at(9.7) })
    const stored = await t.db.select().from(auditLog).orderBy(asc(auditLog.id))
    const result = await inbox()
    const activity = result.activity.filter(i => i.project.id === project.id)
    const resolved = result.resolved.filter(i => i.project.id === project.id)
    const history = [...activity, ...resolved].filter(i => i.type === 'epic_activity')
    expect(history).toHaveLength(events.length + actions.length)
    for (const item of history) {
      const entry = inserted.find(e => `epic-${e.id}` === item.id)!
      const detail = readAudit(entry.detail)
      expect(item).toMatchObject({ epicId: epic!.id, event: detail.event, taskId: null, taskRef: null, subject: epic!.title, at: entry.createdAt.toISOString(), prUrl: 'https://github.com/cormacrw/test-app/pull/12' })
      expect(item.body).toContain(detail.summary)
      expect(item.resolution).toBe(entry.actor.kind === 'human' ? item.body : null)
    }
    expect(resolved.filter(i => i.type === 'epic_activity').map(i => i.resolution)).toEqual([
      'You handed the epic PR rebase to a developer: Human note for rebase_handed_off',
      'You requested changes on the epic PR: Human note for human_changes_requested',
      'You approved the epic PR: Human note for human_approved'
    ])
    expect(activity.find(i => i.id === String(oldRows[0]!.id))).toMatchObject({ type: 'activity', taskId: task.id, body: 'Opened the PR' })
    expect(resolved.find(i => i.id === String(oldRows[1]!.id))).toMatchObject({ type: 'activity', taskId: task.id, resolution: 'You approved the merge' })
    expect(resolved.some(i => i.type === 'release_notes' && i.notes === 'Old release notes')).toBe(true)
    for (const list of [activity, resolved]) expect(list.map(i => i.at)).toEqual(list.map(i => i.at).sort().reverse())
    expect(result.needsYou.find(i => 'epicId' in i && i.epicId === epic!.id)).toMatchObject({ type: 'epic_conflict', taskId: null, taskRef: null, files: ['shared.ts'] })
    expect(await t.db.select().from(auditLog).orderBy(asc(auditLog.id))).toEqual(stored)

    // Deleting the last task cannot hide the epic's history either.
    await t.db.update(tasks).set({ epicId: epic!.id, deletedAt: at(0) }).where(eq(tasks.id, task.id))
    const again = await inbox()
    expect([...again.activity, ...again.resolved].filter(i => i.type === 'epic_activity' && i.epicId === epic!.id)).toEqual(history)
  })
})
