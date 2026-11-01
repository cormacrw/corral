import { flowMetricsQuery, planMessageFields } from '@corral/contracts'
import { checkEpicDependencies, isTaskDone } from '@corral/core'
import type { CreateAgentInput, CreateTaskInput, EpicReviewActionInput, HumanTransitionInput, InboxActionInput, PatchEpicInput, DraftSession, NewPlanMessageFields, Plan, PlanMessage, PlanSessionDetail, StartPlanSessionInput, RunEvent, ServerEvent, Task } from '@corral/contracts'
import { ApiError } from '~/queries/client'
import { STOP_ASKING } from '~/utils/plan-questions'
import * as f from './fixtures'

// The server API for the static prototype (`pnpm prototype`, D20): the same
// paths useApi calls, answered from ./fixtures in memory. Reads return the
// fixtures; writes change them for the session so clicks show their result,
// and reload resets everything. A path nobody handles is a 404, as on the
// server, so a page's error state shows instead of a crash. Writes that the
// server would follow with live events send them through onMockEvent.

type Handler = (params: string[], body: unknown, query: URLSearchParams) => unknown

const routes: [method: string, pattern: RegExp, handler: Handler][] = []
function route(method: string, pattern: string, handler: Handler): void {
  routes.push([method, new RegExp(`^${pattern.replaceAll(/:\w+/g, '([^/]+)')}$`), handler])
}

function notFound(): never {
  throw new ApiError(404, { code: 'not_found' }, 'Not found')
}

function project(slug: string) {
  return f.projects.find(p => p.slug === slug) ?? notFound()
}

function taskIn(slug: string, number: string): Task {
  const p = project(slug)
  return f.tasks.find(t => t.projectId === p.id && t.number === Number(number)) ?? notFound()
}

function session(id: string): PlanSessionDetail {
  const s = f.planSessions.find(x => x.id === id) ?? notFound()
  return { ...s, messages: f.planMessages[id] ?? [], plans: f.plans[id] ?? [] }
}

route('GET', '/health', () => ({ ok: true }))
route('POST', '/runners/:id/update', ([id]) => {
  const runner = f.runner.runners.find(r => r.id === id)!
  runner.draining = true
  runner.updateRequested = true
  runner.updateState = ''
  return runner
})
route('GET', '/runner', () => f.runner)
route('GET', '/status', () => ({ ...f.status, runners: f.runner.runners }))
route('POST', '/stop-all', () => Object.assign(f.status, { stopped: true }))
route('POST', '/resume-all', () => Object.assign(f.status, { stopped: false }))

route('GET', '/setup/repos', () => f.repos)
route('POST', '/setup/check-repo', (_, body) => ({
  repository: (body as { repository: string }).repository,
  defaultBranch: 'main',
  checks: [
    { id: 'can_push', ok: true, title: 'Can push', detail: 'Your GitHub login can push here' },
    { id: 'not_used', ok: true, title: 'Not used', detail: 'No other project uses it' },
    { id: 'cloned', ok: true, title: 'Cloned', detail: 'The runner has a clone' }
  ],
  ready: true
}))
route('GET', '/setup/clis', () => f.clis)

// Return the complete project, including its bundled thumbnailUrl, just like the API.
route('GET', '/projects', () => f.projects)
route('GET', '/projects/:slug/metrics/flow', ([slug], _, query) => {
  project(slug!)
  const parsed = flowMetricsQuery.safeParse({ window: query.get('window') ?? undefined })
  if (!parsed.success) throw new ApiError(400, null, 'Invalid flow window')
  return f.flowMetrics(slug!, parsed.data.window)
})
route('GET', '/projects/:slug', ([slug]) => project(slug!))
route('PATCH', '/projects/:slug', ([slug], body) => {
  const p = Object.assign(project(slug!), body)
  emit({ type: 'project.updated', project: p })
  return p
})
route('PUT', '/projects/:slug/thumbnail', async ([slug], body) => {
  const p = project(slug!)
  const image = (body as FormData).get('file') as Blob
  const thumbnailUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(image)
  })
  Object.assign(p, { thumbnailUrl, updatedAt: new Date().toISOString() })
  emit({ type: 'project.updated', project: p })
  return p
})
route('DELETE', '/projects/:slug/thumbnail', ([slug]) => {
  const p = Object.assign(project(slug!), { thumbnailUrl: null, updatedAt: new Date().toISOString() })
  emit({ type: 'project.updated', project: p })
  return p
})

route('GET', '/projects/:slug/tasks', ([slug], _, query) => {
  const p = project(slug!)
  const view = query.get('view') ?? 'all'
  return f.tasks.filter(t => t.projectId === p.id && t.status !== 'draft'
    && (view === 'all' || (view === 'backlog') === (t.status === 'backlog')))
})
// Backlog's New task action opens the created task on mobile.
route('POST', '/projects/:slug/tasks', ([slug], body) => {
  const p = project(slug!)
  const input = body as CreateTaskInput
  const number = Math.max(p.nextTaskNumber, ...f.tasks.filter(t => t.projectId === p.id).map(t => t.number + 1))
  const task = f.task(p, number, {
    title: input.title, type: input.type, description: input.description ?? null,
    status: 'backlog', priority: input.priority ?? 'medium', epicId: input.epicId ?? null,
    humanReview: input.humanReview ?? p.humanReviewDefault,
    acceptanceCriteria: (input.acceptanceCriteria ?? []).map((text, position) => ({ id: `mock-${number}-${position}`, ...(typeof text === 'string' ? { text } : text), position, met: null })),
    dependsOn: (input.dependsOn ?? []).map(n => `${p.prefix}-${n}`)
  })
  p.nextTaskNumber = number + 1
  f.tasks.push(task)
  emit({ type: 'task.created', task })
  return task
})
route('GET', '/projects/:slug/tasks/:number/designs', ([slug, number]) => {
  const task = taskIn(slug!, number!)
  return task.ref === 'COR-4' ? [{ id: 'design-v1', version: 1, status: 'approved', branch: 'design/COR-4', commitSha: 'design-review-v1', spec: '# Review screen', screenshots: [], previewUrl: '', feedback: null, planSessionId: 's-1', createdAt: f.ago(100) }] : (f.designVersions[task.id] ?? [])
})
route('GET', '/projects/:slug/tasks/:number', ([slug, number]) => taskIn(slug!, number!))
// A real resume goes on to start a run, which the prototype has no use for
route('POST', '/projects/:slug/tasks/:number/resume', ([slug, number]) => {
  const task = taskIn(slug!, number!)
  Object.assign(task, { paused: false, updatedAt: new Date().toISOString() })
  emit({ type: 'task.updated', task })
  return task
})
route('POST', '/projects/:slug/tasks/:number/transitions', ([slug, number], body) => {
  const task = taskIn(slug!, number!)
  const input = body as HumanTransitionInput
  const to = { approve: 'ready', send_back: 'backlog', human_request_changes: 'in_progress' } as const
  Object.assign(task, { status: input.type === 'resolve' ? input.to : to[input.type as keyof typeof to], statusReason: null, updatedAt: new Date().toISOString() })
  emit({ type: 'task.updated', task })
  return task
})
route('POST', '/projects/:slug/tasks/:number/designs/:version/approve', ([slug, number, version]) => {
  const task = taskIn(slug!, number!)
  const design = f.designVersions[task.id]?.find(v => v.version === Number(version)) ?? notFound()
  design.status = 'approved'
  Object.assign(task, { status: 'approved', updatedAt: new Date().toISOString() })
  emit({ type: 'task.updated', task })
  return task
})
route('PATCH', '/projects/:slug/tasks/:number', ([slug, number], body) => {
  const task = taskIn(slug!, number!)
  const previousEpicId = task.epicId
  Object.assign(task, body, { updatedAt: new Date().toISOString() })
  emit({ type: 'task.updated', task })
  // Keep the prototype's live epic totals in step with task edits, as the
  // server does after a merge. Drafts never contribute to these counts.
  for (const id of new Set([previousEpicId, task.epicId])) {
    const epic = f.epics.find(e => e.id === id)
    if (!epic) continue
    const tasks = f.tasks.filter(t => t.epicId === id && t.status !== 'draft')
    Object.assign(epic, {
      taskCount: tasks.length,
      mergedCount: tasks.filter(isTaskDone).length,
      updatedAt: task.updatedAt
    })
    emit({ type: 'epic.updated', epic })
  }
  return task
})
route('GET', '/tasks/:ref', ([ref]) => f.tasks.find(t => t.ref === ref) ?? notFound())
route('GET', '/projects/:slug/tasks/:number/comments', ([slug, number]) => f.comments[taskIn(slug!, number!).id] ?? [])
route('POST', '/projects/:slug/tasks/:number/comments', ([slug, number], body) => {
  const t = taskIn(slug!, number!)
  const input = body as { body: string, pinned: boolean }
  const comment = { id: `cm-${Date.now()}`, taskId: t.id, author: { kind: 'human' as const, userId: f.profile.id }, body: input.body, pinned: input.pinned, createdAt: new Date().toISOString() }
  ;(f.comments[t.id] ??= []).push(comment)
  return comment
})
route('GET', '/projects/:slug/tasks/:number/history', ([slug, number]) => f.history[taskIn(slug!, number!).id] ?? [])
route('GET', '/projects/:slug/tasks/:number/evidence', ([slug, number]) => f.evidence[taskIn(slug!, number!).id] ?? [])
route('GET', '/projects/:slug/tasks/:number/reviews', ([slug, number]) => f.reviews[taskIn(slug!, number!).id] ?? [])

route('GET', '/projects/:slug/pull-requests', ([slug]) => {
  const p = project(slug!)
  return f.pullRequests.filter(pr => pr.taskRef.startsWith(`${p.prefix}-`))
})
route('GET', '/projects/:slug/pull-requests/:number', ([slug, number]) => {
  project(slug!)
  const detail = f.pullRequestDetails.find(pr => pr.number === Number(number))
  if (!detail) throw new ApiError(404, { code: 'pull_request_unavailable', number: Number(number), message: 'Not Found' }, `GitHub couldn't return PR #${number}`)
  return detail
})
route('GET', '/projects/:slug/tasks/:number/pull-request', ([slug, number]) => {
  const { pr } = taskIn(slug!, number!)
  if (pr === null) throw new ApiError(404, { code: 'no_pull_request' }, 'This task has no pull request yet')
  const detail = f.pullRequestDetails.find(d => d.number === pr.number)
  if (!detail) throw new ApiError(404, { code: 'pull_request_unavailable', number: pr.number, message: 'Not Found' }, `GitHub couldn't return PR #${pr.number}`)
  return detail
})
route('GET', '/projects/:slug/epics', ([slug]) => f.epics.filter(e => e.projectId === project(slug!).id))
route('POST', '/epics/:id/review', ([id], body) => {
  const epic = f.epics.find(e => e.id === id) ?? notFound()
  const { action } = body as EpicReviewActionInput
  epic.reviewState = action === 'approve' ? 'ready_to_merge' : action === 'request_changes' ? 'changes_requested' : 'open'
  emit({ type: 'epic.updated', epic })
  return { ok: true }
})
route('PATCH', '/epics/:id', ([id], body) => {
  const epic = f.epics.find(e => e.id === id) ?? notFound()
  const input = body as PatchEpicInput
  if (input.reviewMode && input.reviewMode !== epic.reviewMode && epic.reviewModeLocked) {
    const message = 'The review mode can\'t change once a task in the epic has opened a PR'
    throw new ApiError(409, { code: 'invalid_input', issues: [{ message }] }, message)
  }
  Object.assign(epic, input, { updatedAt: new Date().toISOString() })
  emit({ type: 'epic.updated', epic })
  return epic
})
route('PUT', '/epics/:id/dependencies', ([id], body) => {
  const epic = f.epics.find(e => e.id === id) ?? notFound()
  const all = f.epics.filter(e => e.projectId === epic.projectId)
  const dependsOn = [...new Set((body as { dependsOn: string[] }).dependsOn)]
  const graph = new Map(all.map(e => [e.id, e.id === id ? dependsOn : e.dependsOn]))
  const problems = checkEpicDependencies(graph, f.tasks.filter(t => t.projectId === epic.projectId).map(t => ({
    ...t, dependsOn: t.dependsOn.map(ref => f.tasks.find(x => x.ref === ref)?.id ?? ref)
  })), new Map(all.map(e => [e.id, e.title])))
  if (problems.length) {
    const message = `Dependency cycle or deadlock: ${problems[0]!.epics.join(' → ')}`
    throw new ApiError(400, { code: 'invalid_input', issues: [{ message }] }, message)
  }
  epic.dependsOn = dependsOn
  for (const e of all) {
    e.blocks = all.filter(x => x.dependsOn.includes(e.id)).map(x => x.id)
    emit({ type: 'epic.updated', epic: e })
  }
  return epic
})
route('GET', '/epics/:id', ([id]) => {
  const epic = f.epics.find(e => e.id === id) ?? notFound()
  return { ...epic, tasks: f.tasks.filter(t => t.epicId === epic.id) }
})

route('GET', '/agents', () => f.agents)
route('POST', '/agents', (_, body) => {
  const input = body as CreateAgentInput
  const agent = { ...input, id: `mock-agent-${f.agents.length}`, paused: false, pausedUntil: null, wakeIntervalSeconds: null, activeRuns: 0, avatarUrl: null }
  f.agents.push(agent)
  emit({ type: 'agent.updated', agent })
  return agent
})
route('PATCH', '/agents/:id', ([id], body) => Object.assign(f.agents.find(a => a.id === id) ?? notFound(), body, (body as { paused?: boolean }).paused === false ? { pausedUntil: null } : {}))
route('GET', '/me', () => f.profile)
route('PATCH', '/me', (_, body) => Object.assign(f.profile, body))

route('GET', '/runs', (_, __, query) => f.runs.filter(r =>
  (!query.get('agentId') || r.agentId === query.get('agentId'))
  && (!query.get('taskId') || r.taskId === query.get('taskId'))
  && (!query.get('active') || ['queued', 'starting', 'running', 'waiting_for_input', 'stopping'].includes(r.state))))
route('GET', '/runs/:id', ([id]) => f.runs.find(r => r.id === id) ?? notFound())
route('GET', '/runs/:id/transcript', ([id]) => f.runEvents[id!] ?? [])

// A mid-run message: kept as a comment, then the "runner" delivers it and
// the agent answers, through the same live events as the server's
route('POST', '/projects/:slug/runs/:runId/messages', ([slug, runId], body) => {
  const run = f.runs.find(r => r.id === runId && r.projectId === project(slug!).id) ?? notFound()
  const { text } = body as { text: string }
  const comment = { id: `cm-${Date.now()}`, taskId: run.taskId!, author: { kind: 'human' as const, userId: f.profile.id }, body: text.trim(), pinned: false, createdAt: new Date().toISOString() }
  ;(f.comments[run.taskId!] ??= []).push(comment)
  emit({ type: 'comment.created', comment })
  const deliver = (events: RunEvent[]) => {
    const offset = (f.runEvents[run.id] ??= []).length
    f.runEvents[run.id]!.push(...events)
    emit({ type: 'run.events', runId: run.id, offset, events })
  }
  setTimeout(() => deliver([{ type: 'message', text: comment.body }]), 300)
  setTimeout(() => deliver([{ type: 'message', text: 'Got it, I\'ll do that next.' }]), 1200)
  return { runId: run.id, comment }
})

route('POST', '/deployments/:id/read', ([id]) => {
  const item = f.releaseNotes.find(r => r.deploymentId === id)!
  item.unread = false
  return { ok: true }
})
route('POST', '/deployments/:id/dismiss', ([id]) => {
  const item = f.releaseNotes.find(r => r.deploymentId === id)!
  item.unread = false
  item.resolution = 'You dismissed these release notes'
  return { ok: true }
})
route('GET', '/inbox', () => f.inbox())
// Let the static Inbox exercise send and auto-advance without a server.
route('POST', '/inbox/:taskId/actions', ([taskId], body) => {
  const task = f.tasks.find(t => t.id === taskId) ?? notFound()
  const input = body as InboxActionInput
  if (input.action !== 'approve' && input.action !== 'request_changes') {
    if (input.action === 'delete') f.tasks.splice(f.tasks.indexOf(task), 1)
    else task.status = input.action === 'send_back' ? 'backlog' : input.action === 'resolve' ? input.to : 'in_progress'
    emit({ type: 'task.updated', task })
    return { task: input.action === 'delete' ? null : task }
  }
  const item = f.inbox().needsYou.find(i => i.taskId === taskId)
  if (!item || item.type === 'plan_thread' || item.type === 'epic_review' || item.type === 'epic_conflict' || task.status !== 'human_review') {
    throw new ApiError(409, { code: 'conflict', constraint: null }, 'This review is no longer actionable')
  }
  const accepted = input.action === 'approve'
  const now = new Date().toISOString()
  const approvedDesign = accepted && task.type === 'design'
  Object.assign(task, { status: approvedDesign ? 'approved' : accepted ? 'merged' : 'in_progress', mergedAt: accepted && !approvedDesign ? now : null, updatedAt: now })
  if (input.action === 'request_changes') {
    ;(f.comments[task.id] ??= []).push({ id: `cm-${Date.now()}`, taskId: task.id, author: { kind: 'human', userId: f.profile.id }, body: input.text, pinned: false, createdAt: now })
    task.statusReason = null
  }
  const resolution = approvedDesign ? 'You approved the design' : accepted ? (task.type === 'spike' ? 'You accepted the findings' : 'You approved the merge') : 'You requested changes'
  f.resolvedInbox.unshift({ ...item, message: undefined, since: undefined, newArtifacts: undefined, id: `resolved-${task.id}-${Date.now()}`, type: 'activity', sender: { name: 'You', role: 'system' }, body: resolution, preview: resolution, resolution, at: now })
  emit({ type: 'task.updated', task })
  return { task }
})

route('POST', '/plan/sessions', (_, body) => {
  const { id = crypto.randomUUID(), projectId, text, runtime = 'claude-code', taskRef } = body as StartPlanSessionInput
  const existing = f.planSessions.find(s => s.id === id)
  if (existing) {
    if (existing.projectId !== projectId) throw new ApiError(409, { code: 'conflict', constraint: 'plan_session_project' }, 'Session belongs to another project')
    return session(id)
  }
  const now = new Date().toISOString()
  f.planSessions.unshift({ id, projectId, runtime, title: text.split('\n')[0]!.slice(0, 60) || 'New session', preview: text, unread: false, closed: false, status: 'none', activeRunId: null, createdAt: now, updatedAt: now })
  postMessage(id, { role: 'human', kind: 'message', text: text || `Refine ${taskRef}` })
  emit({ type: 'plan.session', session: f.planSessions[0]! })
  setTimeout(() => {
    postMessage(id, { role: 'pm', kind: 'message', text: 'I will help you work through this plan.' })
  }, 1800)
  return session(id)
})
route('GET', '/plan/sessions', () => f.planSessions)
route('GET', '/plan/sessions/:id', ([id]) => session(id!))
// Drafts by the session they belong to, newest session first, as the server lists them
function drafts(projectId: string): DraftSession[] {
  const rows = f.tasks.filter(t => t.projectId === projectId && t.status === 'draft').toSorted((a, b) => a.number - b.number)
  return f.planSessions
    .filter(s => rows.some(t => t.draftSession?.id === s.id))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(s => ({
      sessionId: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      planStatus: f.plans[s.id]?.at(-1)?.status ?? null,
      drafts: rows.filter(t => t.draftSession?.id === s.id).map(t => ({ taskId: t.id, ref: t.ref, title: t.title, type: t.type, priority: t.priority }))
    }))
}
route('GET', '/projects/:slug/drafts', ([slug]) => drafts(project(slug!).id))
// Approving moves the plan's Drafts to Ready or the Backlog
route('POST', '/plan/plans/:id/approve', ([id], body) => {
  const plan = Object.values(f.plans).flat().find(p => p.id === id) ?? notFound()
  const { to } = body as { to: 'ready' | 'backlog' }
  Object.assign(plan, { status: 'approved', approvedAt: new Date().toISOString(), tasks: plan.tasks.map(p => p.status === 'draft' ? { ...p, status: to } : p) })
  for (const t of f.tasks.filter(t => plan.tasks.some(p => p.taskId === t.id) && t.status === 'draft')) {
    Object.assign(t, { status: to, draftSession: null })
    emit({ type: 'task.updated', task: t })
  }
  const s = f.planSessions.find(x => x.id === plan.sessionId)
  if (s) emit({ type: 'plan.session', session: Object.assign(s, { status: 'none', closed: true, unread: false }) })
  emit({ type: 'plan.updated', plan })
  emit({ type: 'plan.drafts', projectId: plan.projectId, sessions: drafts(plan.projectId) })
  return plan
})
// Closing discards only Drafts and unapproved plans, as the real endpoint does.
route('POST', '/plan/sessions/:id/close', ([id]) => {
  const s = f.planSessions.find(x => x.id === id) ?? notFound()
  for (const task of f.tasks.filter(t => t.draftSession?.id === s.id)) {
    if (task.status === 'draft') {
      f.tasks.splice(f.tasks.indexOf(task), 1)
      emit({ type: 'task.deleted', taskId: task.id, projectId: task.projectId })
    } else {
      Object.assign(task, { draftSession: null })
    }
  }
  for (const plan of f.plans[s.id] ?? []) {
    if (plan.status === 'proposed') {
      plan.status = 'discarded'
      emit({ type: 'plan.updated', plan })
    }
  }
  Object.assign(s, { closed: true, unread: false, status: 'none', activeRunId: null })
  emit({ type: 'plan.session', session: s })
  emit({ type: 'plan.drafts', projectId: s.projectId, sessions: drafts(s.projectId) })
  return s
})
route('POST', '/plan/sessions/:id/read', ([id]) => {
  const s = Object.assign(f.planSessions.find(s => s.id === id) ?? notFound(), { unread: false })
  emit({ type: 'plan.session', session: s })
  return s
})

// The live stream: useLive listens here instead of /api/events
const eventListeners = new Set<(event: ServerEvent) => void>()
export function onMockEvent(listener: (event: ServerEvent) => void): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}
function emit(event: ServerEvent): void {
  for (const listener of eventListeners) listener(JSON.parse(JSON.stringify(event)) as ServerEvent)
}

let nextId = 0
function postMessage(sessionId: string, message: NewPlanMessageFields, links: { planId?: string, runId?: string } = {}): PlanMessage {
  const m: PlanMessage = { planId: null, runId: null, ...links, ...planMessageFields.parse(message), id: `mock-m-${++nextId}`, sessionId, createdAt: new Date().toISOString() }
  ;(f.planMessages[sessionId] ??= []).push(m)
  emit({ type: 'plan.message', message: m })
  return m
}

// Juno's reply, from fixtures.grilling: the next question, or the plan once
// they run out or you say stop
export function pmReply(sessionId: string, text: string): void {
  const s = f.planSessions.find(x => x.id === sessionId)
  const script = f.grilling[sessionId]
  if (!s || !script) return
  const question = text === STOP_ASKING ? undefined : script.questions.shift()
  if (question) {
    postMessage(sessionId, { role: 'pm', kind: 'question', ...question })
    Object.assign(s, { status: 'question', preview: question.text, updatedAt: new Date().toISOString() })
  } else {
    const previous = f.plans[sessionId] ?? []
    const plan: Plan = {
      ...script.plan, id: `mock-plan-${++nextId}`, sessionId, projectId: s.projectId, epicId: null, version: previous.length + 1,
      epics: [], status: 'proposed', approvedAt: null, createdAt: new Date().toISOString()
    }
    ;(f.plans[sessionId] ??= []).push(plan)
    emit({ type: 'plan.updated', plan })
    const summary = `Here is a plan with ${plan.tasks.length} tasks. Approve it to put them on the board.`
    postMessage(sessionId, { role: 'pm', kind: 'message', text: summary }, { planId: plan.id })
    Object.assign(s, { status: 'needs_approval', preview: summary, updatedAt: new Date().toISOString() })
  }
  emit({ type: 'plan.session', session: s })
}

route('POST', '/plan/sessions/:id/messages', ([id], body) => {
  const s = f.planSessions.find(x => x.id === id) ?? notFound()
  const { text } = body as { text: string }
  const message = postMessage(s.id, { role: 'human', kind: 'message', text })
  const runId = `mock-run-${++nextId}`
  Object.assign(s, {
    closed: false, unread: false, activeRunId: runId, preview: text, updatedAt: message.createdAt,
    status: f.plans[s.id]?.some(p => p.status === 'proposed') ? 'needs_approval' : 'none'
  })
  emit({ type: 'plan.session', session: s })
  const reply = 'I will incorporate that into the plan.'
  const updates: RunEvent[] = [
    { type: 'thinking', text: 'Checking the existing plan and your reply.' },
    { type: 'message', text: reply },
    { type: 'thinking', text: 'Preparing the next question or plan.' }
  ]
  for (let i = 1; i <= updates.length; i++) {
    setTimeout(() => {
      const events: RunEvent[] = [updates[i - 1]!]
      const offset = (f.runEvents[runId] ??= []).length
      f.runEvents[runId]!.push(...events)
      emit({ type: 'run.events', runId, offset, events })
    }, i * 400)
  }
  setTimeout(() => {
    if (f.grilling[s.id]) pmReply(s.id, text)
    else {
      postMessage(s.id, { role: 'pm', kind: 'message', text: reply }, { runId })
      Object.assign(s, { preview: reply, status: f.plans[s.id]?.at(-1)?.status === 'proposed' ? 'needs_approval' : 'none' })
    }
    Object.assign(s, { activeRunId: null, unread: true, updatedAt: new Date().toISOString() })
    emit({ type: 'plan.session', session: s })
  }, 1800)
  return message
})

export async function mockCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const [pathname = '', search] = path.split('?')
  for (const [m, pattern, handler] of routes) {
    const match = m === method ? pattern.exec(pathname) : null
    if (!match) continue
    const params = match.slice(1).map(decodeURIComponent)
    // Copies both ways, as if over the wire, so pages and fixtures stay apart
    const input: unknown = body === undefined || body instanceof Blob || body instanceof FormData ? body : JSON.parse(JSON.stringify(body))
    const result = await handler(params, input, new URLSearchParams(search))
    return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as T
  }
  notFound()
}
