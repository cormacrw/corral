import type { AuditEntry, Inbox } from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const { agents, auditLog, runs, tasks } = schema

// Audit actors store only a role and run; the Inbox and task history name
// the agent that acted (bootstrap seeds Juno as the PM, Atlas and Vera)
describe('agent names on activity', () => {
  let t: TestApp

  beforeEach(async () => {
    t = await createTestApp('pglite')
  })

  afterEach(async () => {
    await t?.close()
  })

  async function setup() {
    const project = await t.createProject({ name: 'Names', prefix: 'NAM', repository: 'cormacrw/test-app', defaultBranch: 'main' })
    expect((await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })).status).toBe(200)
    const task = await t.createTask(project.slug, { title: 'Named' })
    await t.db.update(tasks).set({ prNumber: 7, prUrl: 'https://github.com/cormacrw/test-app/pull/7' }).where(eq(tasks.id, task.id))
    const agentId = async (name: string) => (await t.db.select({ id: agents.id }).from(agents).where(eq(agents.name, name)))[0]!.id
    const run = async (name: string, role: 'developer' | 'reviewer') =>
      (await t.db.insert(runs).values({ agentId: await agentId(name), projectId: project.id, taskId: task.id, role, state: 'completed', startedAt: new Date(), endedAt: new Date() }).returning())[0]!.id
    const developerRun = await run('Atlas', 'developer')
    const reviewerRun = await run('Vera', 'reviewer')
    const transition = (actor: Actor, event: string, minutes: number) =>
      ({ projectId: project.id, taskId: task.id, actor, action: 'task.transition', detail: { event, from: 'in_progress', to: 'agent_review' }, createdAt: new Date(Date.now() - minutes * 60_000) })
    await t.db.insert(auditLog).values([
      transition({ kind: 'agent', role: 'developer', runId: developerRun }, 'pr_opened', 5),
      transition({ kind: 'agent', role: 'reviewer', runId: reviewerRun }, 'merged', 4),
      // A run that's gone, and one whose id isn't a run's at all
      transition({ kind: 'agent', role: 'developer', runId: '00000000-0000-4000-8000-000000000009' }, 'pr_updated', 3),
      transition({ kind: 'agent', role: 'designer', runId: 'r-old' }, 'design_submitted', 2),
      transition({ kind: 'human', userId: 'user-1', viaPm: { sessionId: 's1', runId: 'r-pm' } }, 'pr_rebased', 1),
      transition({ kind: 'agent', role: 'pm', runId: 'r-pm' }, 'commit_submitted', 0),
      { projectId: project.id, actor: { kind: 'human', userId: 'user-1', viaPm: { sessionId: 's1', runId: 'r-pm' } }, action: 'pm.action_confirmed', detail: { summary: 'Paused NAM-1', sessionId: 's1' } }
    ])
    return { project, task }
  }

  it('sends Inbox events as the agent that ran them, the PM for confirmed actions, or the role label', async () => {
    const { task } = await setup()
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    const sender = (text: string) => inbox.activity.find(i => i.taskId === task.id && i.preview.startsWith(text))?.sender
    expect(sender('Opened PR #7')).toEqual({ name: 'Atlas', role: 'developer' })
    expect(sender('Merged PR #7')).toEqual({ name: 'Vera', role: 'reviewer' })
    expect(sender('Pushed a revision')).toEqual({ name: 'Developer', role: 'developer' })
    expect(sender('Submitted design')).toEqual({ name: 'Designer', role: 'designer' })
    expect(sender('Rebased PR #7')).toEqual({ name: 'Juno', role: 'pm' })
    expect(sender('Submitted a commit')).toEqual({ name: 'Juno', role: 'pm' })
    expect(inbox.activity.find(i => i.subject === 'Paused NAM-1, confirmed by you')?.sender).toEqual({ name: 'Juno', role: 'pm' })
  })

  it('names the agent on each task history entry, or null when it is gone', async () => {
    const { project, task } = await setup()
    const history = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/history`).then(r => r.json()) as AuditEntry[]
    const names = history.filter(e => e.action === 'task.transition').map(e => [e.detail.event, e.agentName])
    expect(names).toEqual([['pr_opened', 'Atlas'], ['merged', 'Vera'], ['pr_updated', null], ['design_submitted', null], ['pr_rebased', 'Juno'], ['commit_submitted', 'Juno']])
    expect(history.find(e => e.action === 'task.created')?.agentName).toBeNull()
  })

  it('falls back to the PM role label when there is no PM agent', async () => {
    const { task } = await setup()
    await t.db.update(agents).set({ role: 'developer' }).where(eq(agents.role, 'pm'))
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.activity.find(i => i.taskId === task.id && i.preview.startsWith('Rebased'))?.sender).toEqual({ name: 'PM', role: 'pm' })
  })
})
