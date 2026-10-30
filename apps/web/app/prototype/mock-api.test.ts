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

  it('includes thumbnails on project and inbox responses', async () => {
    const projects = await mockCall<Project[]>('GET', '/projects')
    expect(projects.filter(p => p.thumbnailUrl)).toHaveLength(1)
    const corral = projects.find(p => p.slug === 'corral')!
    expect(corral.thumbnailUrl).toMatch(/^data:image\/svg\+xml,/)
    const detail = await mockCall<Project>('GET', '/projects/corral')
    expect(detail.thumbnailUrl).toBe(corral.thumbnailUrl)
    const inbox = await mockCall<Inbox>('GET', '/inbox')
    expect(inbox.needsYou.filter(i => i.project.id === corral.id).every(i => i.project.thumbnailUrl === corral.thumbnailUrl)).toBe(true)
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
    expect(inbox.count).toBe(inbox.needsYou.length)
    const threads = inbox.needsYou.filter(i => i.type === 'plan_thread')
    expect(threads.map(i => i.sessionId).sort()).toEqual(['s-1', 's-2', 's-3', 's-5'])
    expect(inbox.needsYou.map(i => i.at)).toEqual(inbox.needsYou.map(i => i.at).sort().reverse())
    expect(threads.find(i => i.sessionId === 's-5')).toMatchObject({ status: 'none', unread: true, question: null, plan: null, reply: expect.stringContaining('SSE reconnect') })
    expect(threads.find(i => i.sessionId === 's-2')).toMatchObject({
      question: { text: 'Which push service should we use?', recommendation: 'Web Push', options: ['Web Push with VAPID keys', 'ntfy'] },
      plan: null
    })
    expect(threads.find(i => i.sessionId === 's-1')).toMatchObject({
      question: null, plan: { id: 'plan-1', version: 1, epicCount: 1, taskCount: 3 }
    })
    expect(threads.every(i => !('body' in i))).toBe(true)
    expect(inbox.needsYou.filter(i => i.type !== 'plan_thread').map(i => i.type).sort()).toEqual(['blocked', 'failed', 'human_review'])
    expect(threads.some(i => i.sessionId === 's-idle')).toBe(false)
  })

  it('drops an unread-reply thread from the inbox once it is read', async () => {
    await mockCall('POST', '/plan/sessions/s-5/read')
    const inbox = await mockCall<Inbox>('GET', '/inbox')
    expect(inbox.needsYou.some(i => i.id === 's-5')).toBe(false)
    expect(inbox.count).toBe(inbox.needsYou.length)
  })

  it('opens a plan session with its messages and plans', async () => {
    const session = await mockCall<PlanSessionDetail>('GET', '/plan/sessions/s-1')
    expect(session.messages.length).toBeGreaterThan(0)
    expect(session.plans.length).toBeGreaterThan(0)
  })

  it('marks an Inbox thread read and broadcasts the shared state', async () => {
    const events: ServerEvent[] = []
    const stop = onMockEvent(e => events.push(e))
    await mockCall('POST', '/plan/sessions/s-1/read')
    stop()
    const inbox = await mockCall<Inbox>('GET', '/inbox')
    expect(inbox.needsYou.find(i => i.id === 's-1')).toMatchObject({ unread: false, status: 'needs_approval' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan.session', session: expect.objectContaining({ id: 's-1', unread: false }) }))
  })

  it('keeps writes for the session and returns copies', async () => {
    const before = await mockCall<Project>('GET', '/projects/corral')
    before.name = 'Changed by the page'
    expect((await mockCall<Project>('GET', '/projects/corral')).name).toBe('Corral')

    await mockCall('PATCH', '/projects/corral', { paused: true })
    expect((await mockCall<Project>('GET', '/projects/corral')).paused).toBe(true)
  })

  it('broadcasts updated epic progress when a task merges, excluding Drafts', async () => {
    const events: ServerEvent[] = []
    const stop = onMockEvent(event => events.push(event))
    try {
      await mockCall('PATCH', '/projects/corral/tasks/8', { status: 'merged' })
      expect(events).toContainEqual(expect.objectContaining({
        type: 'epic.updated', epic: expect.objectContaining({ id: 'e-mobile', taskCount: 3, mergedCount: 2 })
      }))
      await mockCall('PATCH', '/projects/corral/tasks/6', { status: 'merged' })
      expect(events).toContainEqual(expect.objectContaining({
        type: 'epic.updated', epic: expect.objectContaining({ id: 'e-design', taskCount: 7, mergedCount: 3 })
      }))
    } finally {
      await mockCall('PATCH', '/projects/corral/tasks/8', { status: 'blocked' })
      await mockCall('PATCH', '/projects/corral/tasks/6', { status: 'ready' })
      stop()
    }
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
    expect((await mockCall<Inbox>('GET', '/inbox')).needsYou.some(i => i.id === 's-2')).toBe(false)
    vi.runAllTimers()
    vi.useRealTimers()
    pmReply('s-2', STOP_ASKING)
    stop()
    expect(events).toEqual(['human:message', 'plan.session', 'run.events', 'run.events', 'run.events', 'pm:question', 'plan.session', 'plan.session', 'plan.updated', 'pm:message', 'plan.session'])
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
    const inbox = await mockCall<Inbox>('GET', '/inbox')
    expect(inbox.needsYou.some(i => i.id === 's-3')).toBe(false)
    await expect(mockCall<PlanSessionDetail>('GET', '/plan/sessions/s-3')).resolves.toMatchObject({ closed: true, unread: false })
    await expect(mockCall<Task>('GET', '/tasks/COR-16')).resolves.toMatchObject({ status: 'backlog', planSessionId: null })
  })
  it('creates a Backlog task without reusing a draft number and makes it readable by ref', async () => {
    const before = await mockCall<Task[]>('GET', '/projects/corral/tasks')
    const events: ServerEvent[] = []
    const stop = onMockEvent(e => events.push(e))
    const task = await mockCall<Task>('POST', '/projects/corral/tasks', { title: 'New task', type: 'task', description: null })
    stop()
    expect(before.some(t => t.ref === task.ref)).toBe(false)
    expect(task.number).toBeGreaterThan(17)
    expect(task).toMatchObject({ title: 'New task', type: 'task', status: 'backlog', description: null })
    await expect(mockCall<Task>('GET', `/tasks/${task.ref}`)).resolves.toEqual(task)
    expect(events).toEqual([{ type: 'task.created', task }])
  })

  it('approves to the board, closes the thread and keeps it out of Resolved', async () => {
    await mockCall('POST', '/plan/plans/plan-1/approve', { to: 'ready' })
    const inbox = await mockCall<Inbox>('GET', '/inbox')
    expect(inbox.needsYou.some(i => i.id === 's-1')).toBe(false)
    expect(inbox.resolved.some(i => i.id === 's-1')).toBe(false)
    await expect(mockCall<Task>('GET', '/tasks/COR-13')).resolves.toMatchObject({ status: 'ready' })
    await expect(mockCall<PlanSessionDetail>('GET', '/plan/sessions/s-1')).resolves.toMatchObject({ closed: true })
  })
  it('closes a thread, discards its drafts and plan, and removes it from the Inbox', async () => {
    vi.resetModules()
    const { mockCall } = await import('./mock-api')
    await mockCall('POST', '/plan/sessions/s-1/close')
    const detail = await mockCall<PlanSessionDetail>('GET', '/plan/sessions/s-1')
    expect(detail).toMatchObject({ closed: true, status: 'none', activeRunId: null })
    expect(detail.plans.find(p => p.id === 'plan-1')?.status).toBe('discarded')
    const inbox = await mockCall<Inbox>('GET', '/inbox')
    expect([...inbox.needsYou, ...inbox.resolved].some(i => i.id === 's-1')).toBe(false)
    expect((await mockCall<DraftSession[]>('GET', '/projects/corral/drafts')).some(s => s.sessionId === 's-1')).toBe(false)
    await expect(mockCall('GET', '/tasks/COR-13')).rejects.toMatchObject({ status: 404 })
    // Approved Backlog tasks from another session survive closing.
    await mockCall('POST', '/plan/plans/plan-3/approve', { to: 'backlog' })
    await mockCall('POST', '/plan/sessions/s-3/close')
    await expect(mockCall<Task>('GET', '/tasks/COR-16')).resolves.toMatchObject({ status: 'backlog' })
  })
  it('resumes a paused task', async () => {
    await expect(mockCall('GET', '/tasks/COR-18')).resolves.toMatchObject({ status: 'agent_review', paused: true })
    await expect(mockCall('POST', '/projects/corral/tasks/18/resume')).resolves.toMatchObject({ status: 'agent_review', paused: false })
    await expect(mockCall('GET', '/tasks/COR-18')).resolves.toMatchObject({ paused: false })
  })

  it('closes a thread: discards its drafts and plan, and drops it from the inbox', async () => {
    // Fresh fixtures: the tests above approved s-3's plan
    vi.resetModules()
    const { mockCall, onMockEvent } = await import('./mock-api')
    const events: ServerEvent[] = []
    const stop = onMockEvent(event => events.push(event))
    await expect(mockCall('POST', '/plan/sessions/s-3/close')).resolves.toMatchObject({ closed: true, status: 'none' })
    stop()
    const inbox = await mockCall<Inbox>('GET', '/inbox')
    expect(inbox.needsYou.some(i => i.id === 's-3')).toBe(false)
    expect(inbox.resolved.some(i => i.id === 's-3')).toBe(false)
    await expect(mockCall('GET', '/tasks/COR-16')).rejects.toMatchObject({ status: 404 })
    const detail = await mockCall<PlanSessionDetail>('GET', '/plan/sessions/s-3')
    expect(detail.plans.every(p => p.status === 'discarded')).toBe(true)
    expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['task.deleted', 'plan.updated', 'plan.session', 'plan.drafts']))
  })
  it('starts and retries a client UUID as one session with one human message', async () => {
    vi.useFakeTimers()
    try {
      const [project] = await mockCall<Project[]>('GET', '/projects')
      const id = '1568b7db-293e-4fc2-a670-b62dc0088e17'
      const body = { id, projectId: project!.id, text: 'Plan a small change', runtime: 'codex' }
      const first = await mockCall<PlanSessionDetail>('POST', '/plan/sessions', body)
      const retry = await mockCall<PlanSessionDetail>('POST', '/plan/sessions', body)
      expect(first.id).toBe(id)
      expect(retry.messages).toEqual(first.messages)
      expect(retry.messages.filter(m => m.role === 'human')).toHaveLength(1)
      expect(await mockCall('GET', `/plan/sessions/${id}`)).toEqual(retry)
      await vi.runAllTimersAsync()
      const replied = await mockCall<PlanSessionDetail>('GET', `/plan/sessions/${id}`)
      expect(replied.messages.filter(m => m.role === 'pm')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
