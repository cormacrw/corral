import type { DraftSession, EpicDetail, Inbox, PlanSessionDetail, Project, PullRequestStatus, ServerEvent, Task } from '@corral/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '~/composables/useApi'
import { STOP_ASKING } from '~/utils/plan-questions'
import { mockCall, onMockEvent, pmReply } from './mock-api'

describe('prototype mock API', () => {
  it('answers everything the shell loads at startup', async () => {
    for (const path of ['/projects', '/agents', '/runner', '/status', '/inbox', '/plan/sessions', '/me']) {
      await expect(mockCall('GET', path), path).resolves.toBeTruthy()
    }
  })

  it('serves a project\'s open PRs, with eligible and blocked ones', async () => {
    const prs = await mockCall<PullRequestStatus[]>('GET', '/projects/corral/pull-requests')
    expect(prs.every(pr => pr.taskRef.startsWith('COR-'))).toBe(true)
    expect(prs.some(pr => pr.merge.eligible)).toBe(true)
    expect(prs.some(pr => !pr.merge.eligible && pr.merge.failingGate)).toBe(true)
    await expect(mockCall('GET', '/projects/marketing-site/pull-requests')).resolves.toEqual([])
  })

  it('serves a project, its tasks by view, a task and an epic', async () => {
    const [project] = await mockCall<Project[]>('GET', '/projects')
    const all = await mockCall<Task[]>('GET', `/projects/${project!.slug}/tasks?view=all`)
    const backlog = await mockCall<Task[]>('GET', `/projects/${project!.slug}/tasks?view=backlog`)
    const board = await mockCall<Task[]>('GET', `/projects/${project!.slug}/tasks?view=board`)
    expect(backlog.length).toBeGreaterThan(0)
    expect(backlog.every(t => t.status === 'backlog')).toBe(true)
    expect(board.some(t => t.status === 'backlog')).toBe(false)
    expect(board.length + backlog.length).toBe(all.length)

    const task = await mockCall<Task>('GET', `/tasks/${all[0]!.ref}`)
    expect(task.id).toBe(all[0]!.id)
    const epic = await mockCall<EpicDetail>('GET', `/epics/${all.find(t => t.epicId)!.epicId}`)
    expect(epic.tasks.length).toBeGreaterThan(0)
  })

  it('derives the inbox from tasks that need the human', async () => {
    const inbox = await mockCall<Inbox>('GET', '/inbox')
    expect(inbox.needsYou.map(i => i.type).sort()).toEqual(['blocked', 'failed', 'human_review'])
  })

  it('opens a plan session with its messages and plans', async () => {
    const session = await mockCall<PlanSessionDetail>('GET', '/plan/sessions/s-1')
    expect(session.messages.length).toBeGreaterThan(0)
    expect(session.plans.length).toBeGreaterThan(0)
  })

  it('keeps writes for the session and returns copies', async () => {
    const before = await mockCall<Project>('GET', '/projects/corral')
    before.name = 'Changed by the page'
    expect((await mockCall<Project>('GET', '/projects/corral')).name).toBe('Corral')

    await mockCall('PATCH', '/projects/corral', { paused: true })
    expect((await mockCall<Project>('GET', '/projects/corral')).paused).toBe(true)
  })

  it('is a 404 for anything it does not handle, as on the server', async () => {
    await expect(mockCall('GET', '/projects/nope')).rejects.toBeInstanceOf(ApiError)
    await expect(mockCall('DELETE', '/agents/a-dev')).rejects.toMatchObject({ status: 404, body: { code: 'not_found' } })
  })

  it('answers a Plan reply with the next question, then the plan on Stop', async () => {
    const events: string[] = []
    const stop = onMockEvent(e => events.push(e.type === 'plan.message' ? `${e.message.role}:${e.message.kind}` : e.type))
    vi.useFakeTimers()
    await mockCall('POST', '/plan/sessions/s-2/messages', { text: 'Web Push' })
    vi.runAllTimers()
    vi.useRealTimers()
    pmReply('s-2', STOP_ASKING)
    stop()
    expect(events).toEqual(['human:message', 'pm:question', 'plan.session', 'plan.updated', 'pm:message', 'plan.session'])
    const detail = await mockCall<PlanSessionDetail>('GET', '/plan/sessions/s-2')
    expect(detail.plans.at(-1)?.status).toBe('proposed')
    expect(detail.status).toBe('needs_approval')
  })

  it('lists drafts by session, and drops a session\'s drafts when its plan is approved', async () => {
    const before = await mockCall<DraftSession[]>('GET', '/projects/corral/drafts')
    expect(before.map(s => [s.sessionId, s.drafts.map(d => d.ref)])).toEqual([
      ['s-1', ['COR-13', 'COR-14', 'COR-15']],
      ['s-3', ['COR-16', 'COR-17']]
    ])
    await expect(mockCall('GET', '/projects/marketing-site/drafts')).resolves.toEqual([])
    const events: ServerEvent[] = []
    const stop = onMockEvent(e => events.push(e))
    await mockCall('POST', '/plan/plans/plan-3/approve', { to: 'backlog' })
    stop()
    const drafts = events.find(e => e.type === 'plan.drafts')
    expect(drafts?.type === 'plan.drafts' && drafts.sessions.map(s => s.sessionId)).toEqual(['s-1'])
    await expect(mockCall<Task>('GET', '/tasks/COR-16')).resolves.toMatchObject({ status: 'backlog', planSessionId: null })
  })
})
