import { flowMetricsQuery, planMessageFields } from '@corral/contracts'
import { checkEpicDependencies, DEFAULT_AGENT_RUNTIME, deliveryCounts, isActiveRun } from '@corral/core'
import type { Agent, Attachment, CreateTaskInput, Deployment, DraftSession, EndpointBody, EndpointParams, EndpointQuery, EndpointResponse, NewPlanMessageFields, Plan, PlanMessage, PlanSessionDetail, Profile, Project, PullRequestDetail, PullRequestGuide, ReleaseNotesItem, RunEvent, ServerEvent, Task, WebEndpoint } from '@corral/contracts'
import { ApiError } from '~/queries/client'
import { STOP_ASKING } from '~/features/plan/utils/plan-questions'
import * as f from './fixtures'

// The server API for the static prototype (`pnpm prototype`, D20): every
// endpoint the web client calls (`web` in the contracts endpoint table),
// answered from ./fixtures in memory. Reads return the fixtures; writes change
// them for the session so clicks show their result, and reload resets
// everything. Writes send the live events the server publishes for them
// through onMockEvent.

interface MockRequest<K extends WebEndpoint> {
  params: EndpointParams<K>
  body: EndpointBody<K>
  query: EndpointQuery<K>
}
type MockRoutes = { [K in WebEndpoint]: (request: MockRequest<K>) => EndpointResponse<K> | Promise<EndpointResponse<K>> }

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

function dataUrl(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function flowWindow(window: string | undefined) {
  const parsed = flowMetricsQuery.safeParse({ window })
  if (!parsed.success) throw new ApiError(400, null, 'Invalid flow window')
  return parsed.data.window
}

function patchAgent(id: string, fields: Partial<Agent>): Agent {
  const agent = Object.assign(f.agents.find(a => a.id === id) ?? notFound(), fields)
  emit({ type: 'agent.updated', agent })
  return agent
}

function patchProfile(fields: Partial<Profile>): Profile {
  const profile = Object.assign(f.profile, fields)
  emit({ type: 'profile.updated', profile })
  return profile
}

function setStatus(fields: Partial<typeof f.status>) {
  Object.assign(f.status, fields)
  emit({ type: 'global.status', status: f.status })
  return f.status
}

function releaseDeployment(item: ReleaseNotesItem): Deployment {
  return { id: item.deploymentId, projectId: item.project.id, fromSha: item.fromSha, toSha: item.toSha, commits: [], notes: item.notes, notesStatus: item.notesStatus, readAt: item.unread ? null : new Date().toISOString(), createdAt: item.at }
}

// Guides asked for this session, by PR number
const guides = new Map<number, PullRequestGuide>()

function pullRequestDetail(number: number): PullRequestDetail {
  const detail = f.pullRequestDetails.find(pr => pr.number === number)
  if (!detail) throw new ApiError(404, { code: 'pull_request_unavailable', number, message: 'Not Found' }, `GitHub couldn't return PR #${number}`)
  return detail
}

// Backlog's New task action opens the created task on mobile.
function addTask(slug: string, input: CreateTaskInput): Task {
  const p = project(slug)
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
}

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
function pmReply(sessionId: string, text: string): void {
  const s = f.planSessions.find(x => x.id === sessionId)
  const script = f.grilling[sessionId]
  if (!s || !script || !s.projectId) return
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

const routes: MockRoutes = {
  'POST /runners/:runnerId/update': ({ params }) => {
    const runner = f.runner.runners.find(r => r.id === params.runnerId) ?? notFound()
    Object.assign(runner, { draining: true, updateRequested: true, updateState: '' })
    emit({ type: 'runner.status', status: f.runner })
    return runner
  },
  'GET /runner': () => f.runner,
  'GET /status': () => ({ ...f.status, runners: f.runner.runners }),
  'DELETE /update-hold': () => setStatus({ updating: false }),
  'POST /stop-all': () => setStatus({ stopped: true }),
  'POST /resume-all': () => setStatus({ stopped: false }),

  'GET /perf/summary': ({ query }) => f.perfSummaries[query.window ?? '24h'],

  'GET /setup/repos': () => f.repos,
  'POST /setup/check-repo': ({ body }) => ({
    repository: body.repository,
    defaultBranch: 'main',
    checks: [
      { id: 'can_push', ok: true, title: 'Can push', detail: 'Your GitHub login can push here' },
      { id: 'not_used', ok: true, title: 'Not used', detail: 'No other project uses it' },
      { id: 'cloned', ok: true, title: 'Cloned', detail: 'The runner has a clone' }
    ],
    ready: true
  }),
  'GET /setup/clis': () => f.clis,

  'GET /projects': () => f.projects,
  'POST /projects': ({ body }) => {
    const now = new Date().toISOString()
    const created: Project = {
      ...f.projects[0]!, id: `mock-project-${++nextId}`, name: body.name, slug: body.slug ?? body.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, ''),
      prefix: body.prefix, repository: body.repository, defaultBranch: body.defaultBranch, thumbnailColor: null, thumbnailUrl: null, nextTaskNumber: 1, paused: false,
      ...(body.mergeMethod && { mergeMethod: body.mergeMethod }),
      ...(body.humanReviewDefault !== undefined && { humanReviewDefault: body.humanReviewDefault }),
      ...(body.epicReviewModeDefault && { epicReviewModeDefault: body.epicReviewModeDefault }),
      createdAt: now, updatedAt: now
    }
    f.projects.push(created)
    emit({ type: 'project.created', project: created })
    return created
  },
  'GET /projects/:slug/metrics/flow': ({ params, query }) => {
    project(params.slug)
    return f.flowMetrics(params.slug, flowWindow(query.window))
  },
  // Cycle time across projects (Home): the busiest project's figures stand in
  'GET /metrics/flow': ({ query }) => {
    const window = flowWindow(query.window)
    const { mergedTaskCount, cycleTime } = f.flowMetrics(f.projects[0]!.slug, window)
    return {
      window,
      current: { mergedTaskCount, cycleTime },
      previous: { mergedTaskCount, cycleTime: { medianMs: cycleTime.medianMs * 1.2, p90Ms: cycleTime.p90Ms * 1.1 } }
    }
  },
  'PATCH /projects/:slug': ({ params, body }) => {
    const p = Object.assign(project(params.slug), body)
    emit({ type: 'project.updated', project: p })
    return p
  },
  'DELETE /projects/:slug': ({ params, body }) => {
    const p = project(params.slug)
    if (body.confirm !== p.name) throw new ApiError(400, { code: 'invalid_input', issues: [{ path: ['confirm'], message: 'Type the project name to remove it' }] }, 'Type the project name to remove it')
    f.projects.splice(f.projects.indexOf(p), 1)
    emit({ type: 'project.deleted', projectId: p.id })
  },
  'PUT /projects/:slug/thumbnail': async ({ params, body }) => {
    const p = project(params.slug)
    Object.assign(p, { thumbnailUrl: await dataUrl(body.get('file') as Blob), updatedAt: new Date().toISOString() })
    emit({ type: 'project.updated', project: p })
    return p
  },
  'DELETE /projects/:slug/thumbnail': ({ params }) => {
    const p = Object.assign(project(params.slug), { thumbnailUrl: null, updatedAt: new Date().toISOString() })
    emit({ type: 'project.updated', project: p })
    return p
  },

  'GET /projects/:slug/tasks': ({ params }) => {
    const p = project(params.slug)
    return f.tasks.filter(t => t.projectId === p.id && t.status !== 'draft')
  },
  'POST /projects/:slug/tasks': ({ params, body }) => addTask(params.slug, body as CreateTaskInput),
  'POST /projects/:slug/tasks/:number/subtasks': ({ params, body }) => {
    const p = project(params.slug)
    const parent = taskIn(params.slug, params.number)
    const delivery = parent.rollup ? f.epics.find(e => e.id === parent.rollup!.epicId) : f.addParent(p, parent)
    const created = addTask(p.slug, { ...body as CreateTaskInput, epicId: delivery!.id })
    created.parentTask = { id: parent.id, ref: parent.ref, title: parent.title }
    parent.rollup!.total++
    emit({ type: 'task.updated', task: parent })
    return created
  },
  'GET /projects/:slug/tasks/:number/designs': ({ params }) => {
    const task = taskIn(params.slug, params.number)
    return task.ref === 'COR-4' ? [{ id: 'design-v1', version: 1, status: 'approved', branch: 'design/COR-4', commitSha: 'design-review-v1', spec: '# Review screen', screenshots: [], previewUrl: '', feedback: null, planSessionId: 's-1', createdAt: f.ago(100) }] : (f.designVersions[task.id] ?? [])
  },
  // A real resume goes on to start a run, which the prototype has no use for
  'POST /projects/:slug/tasks/:number/resume': ({ params }) => {
    const task = taskIn(params.slug, params.number)
    Object.assign(task, { paused: false, updatedAt: new Date().toISOString() })
    emit({ type: 'task.updated', task })
    return task
  },
  'POST /projects/:slug/tasks/:number/transitions': ({ params, body }) => {
    const task = taskIn(params.slug, params.number)
    const to = { approve: 'ready', send_back: 'backlog', human_request_changes: 'in_progress' } as const
    Object.assign(task, { status: body.type === 'resolve' ? body.to : to[body.type as keyof typeof to], statusReason: null, updatedAt: new Date().toISOString() })
    emit({ type: 'task.updated', task })
    return task
  },
  'POST /projects/:slug/tasks/:number/designs/:version/approve': ({ params }) => {
    const task = taskIn(params.slug, params.number)
    const design = f.designVersions[task.id]?.find(v => v.version === Number(params.version)) ?? notFound()
    design.status = 'approved'
    Object.assign(task, { status: 'approved', updatedAt: new Date().toISOString() })
    emit({ type: 'task.updated', task })
    return task
  },
  'PATCH /projects/:slug/tasks/:number': ({ params, body }) => {
    const task = taskIn(params.slug, params.number)
    const previousEpicId = task.epicId
    Object.assign(task, body, { updatedAt: new Date().toISOString() })
    emit({ type: 'task.updated', task })
    // Keep the prototype's live epic totals in step with task edits, as the
    // server does after a merge.
    for (const id of new Set([previousEpicId, task.epicId])) {
      const epic = f.epics.find(e => e.id === id)
      if (!epic) continue
      Object.assign(epic, {
        ...deliveryCounts(f.tasks.filter(t => t.epicId === id)),
        updatedAt: task.updatedAt
      })
      emit({ type: 'epic.updated', epic })
    }
    return task
  },
  'DELETE /projects/:slug/tasks/:number': ({ params }) => {
    const task = taskIn(params.slug, params.number)
    f.tasks.splice(f.tasks.indexOf(task), 1)
    emit({ type: 'task.deleted', taskId: task.id, projectId: task.projectId })
  },
  'GET /tasks/:ref': ({ params }) => f.tasks.find(t => t.ref === params.ref) ?? notFound(),
  'GET /projects/:slug/tasks/:number/comments': ({ params }) => f.comments[taskIn(params.slug, params.number).id] ?? [],
  'POST /projects/:slug/tasks/:number/comments': ({ params, body }) => {
    const t = taskIn(params.slug, params.number)
    const comment = { id: `cm-${Date.now()}`, taskId: t.id, author: { kind: 'human' as const, userId: f.profile.id }, body: body.body, pinned: body.pinned ?? false, createdAt: new Date().toISOString() }
    ;(f.comments[t.id] ??= []).push(comment)
    emit({ type: 'comment.created', comment })
    return comment
  },
  'GET /projects/:slug/tasks/:number/history': ({ params }) => f.history[taskIn(params.slug, params.number).id] ?? [],
  'GET /projects/:slug/tasks/:number/evidence': ({ params }) => f.evidence[taskIn(params.slug, params.number).id] ?? [],
  'GET /projects/:slug/tasks/:number/reviews': ({ params }) => f.reviews[taskIn(params.slug, params.number).id] ?? [],

  'POST /projects/:slug/attachments': async ({ params, body, query }) => {
    project(params.slug)
    const id = `mock-attachment-${++nextId}`
    return { id, mimeType: body.type as Attachment['mimeType'], fileName: query.name ?? 'image', byteSize: body.size, url: await dataUrl(body) }
  },

  'GET /projects/:slug/pull-requests': ({ params }) => {
    const p = project(params.slug)
    return f.pullRequests.filter(pr => pr.taskRef.startsWith(`${p.prefix}-`))
  },
  'GET /projects/:slug/pull-requests/:number': ({ params }) => {
    project(params.slug)
    return pullRequestDetail(Number(params.number))
  },
  'GET /projects/:slug/pull-requests/:number/guide': ({ params }) => {
    project(params.slug)
    return guides.get(Number(params.number)) ?? { status: 'none', headSha: null, steps: [], error: null, generatedAt: null }
  },
  // Ready at once: one step per file, in the PR's order
  'POST /projects/:slug/pull-requests/:number/guide': ({ params }) => {
    project(params.slug)
    const detail = pullRequestDetail(Number(params.number))
    const guide: PullRequestGuide = {
      status: 'ready', headSha: detail.headSha, error: null, generatedAt: new Date().toISOString(),
      steps: detail.files.map((file, index) => ({ id: `step-${index + 1}`, title: file.path, why: `The ${file.status} file in this change.`, criterionIds: [], hunks: file.patch ? [{ path: file.path, hunk: 0 }] : [] }))
    }
    guides.set(detail.number, guide)
    return guide
  },

  'GET /projects/:slug/epics': ({ params }) => f.epics.filter(e => e.projectId === project(params.slug).id),
  'GET /epics/:id/review': ({ params }) => {
    const review = f.epicReview(params.id) ?? notFound()
    if (review.reviewMode === 'direct') {
      const message = 'This task merges its subtasks straight to the target branch, so it has no task review'
      throw new ApiError(409, { code: 'invalid_input', issues: [{ message }] }, message)
    }
    return review
  },
  'POST /epics/:id/review': ({ params, body }) => {
    const epic = f.epics.find(e => e.id === params.id) ?? notFound()
    const { action, headSha } = body
    if (action === 'decide') return { ok: true }
    // As on the server: a moved head loses review, so the item leaves the Inbox
    if (headSha === 'stale-head') {
      Object.assign(epic, { reviewState: 'in_review', prHeadSha: 'moved-head' })
      emit({ type: 'epic.updated', epic })
      throw new ApiError(409, { code: 'conflict', constraint: 'epic_review_changed' }, 'epic_review_changed')
    }
    epic.reviewState = action === 'approve' ? 'ready_to_merge' : action === 'request_changes' ? 'changes_requested' : 'open'
    emit({ type: 'epic.updated', epic })
    return { ok: true }
  },
  // The rebase starts over; the prototype has no rebase to run
  'POST /epics/:id/sync/retry': ({ params }) => {
    const epic = f.epics.find(e => e.id === params.id) ?? notFound()
    Object.assign(epic, { sync: null, updatedAt: new Date().toISOString() })
    emit({ type: 'epic.updated', epic })
    return { ok: true }
  },
  'PATCH /epics/:id': ({ params, body }) => {
    const epic = f.epics.find(e => e.id === params.id) ?? notFound()
    if (body.reviewMode && body.reviewMode !== epic.reviewMode && epic.reviewModeLocked) {
      const message = 'The review mode can\'t change once a subtask has opened a PR'
      throw new ApiError(409, { code: 'invalid_input', issues: [{ message }] }, message)
    }
    Object.assign(epic, body, { updatedAt: new Date().toISOString() })
    emit({ type: 'epic.updated', epic })
    return epic
  },
  'PUT /epics/:id/dependencies': ({ params, body }) => {
    const epic = f.epics.find(e => e.id === params.id) ?? notFound()
    const all = f.epics.filter(e => e.projectId === epic.projectId)
    const dependsOn = [...new Set(body.dependsOn)]
    const graph = new Map(all.map(e => [e.id, e.id === epic.id ? dependsOn : e.dependsOn]))
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
  },
  'GET /epics/:id/activity': () => [],
  'GET /epics/:id': ({ params }) => {
    const epic = f.epics.find(e => e.id === params.id) ?? notFound()
    return { ...epic, tasks: f.tasks.filter(t => t.epicId === epic.id), fixes: f.epicFixes[epic.id] ?? [] }
  },
  'GET /epics/:id/history': () => f.epicHistory,

  'GET /agents': () => f.agents,
  'POST /agents': ({ body }) => {
    const agent = { ...body, id: `mock-agent-${f.agents.length}`, paused: false, pausedUntil: null, wakeIntervalSeconds: null, activeRuns: 0, avatarUrl: null } as Agent
    f.agents.push(agent)
    emit({ type: 'agent.updated', agent })
    return agent
  },
  'PATCH /agents/:id': ({ params, body }) => patchAgent(params.id, { ...body, ...(body.paused === false && { pausedUntil: null }) } as Partial<Agent>),
  'PUT /agents/:id/avatar': async ({ params, body }) => patchAgent(params.id, { avatarUrl: await dataUrl(body) }),
  'DELETE /agents/:id/avatar': ({ params }) => patchAgent(params.id, { avatarUrl: null }),
  'GET /me': () => f.profile,
  'PATCH /me': ({ body }) => patchProfile(body),
  'PUT /me/avatar': async ({ body }) => patchProfile({ avatarUrl: await dataUrl(body) }),
  'DELETE /me/avatar': () => patchProfile({ avatarUrl: null }),

  'GET /runs': ({ query }) => f.runs.filter(r =>
    (!query.agentId || r.agentId === query.agentId)
    && (!query.taskId || r.taskId === query.taskId)
    && (query.active !== '1' || isActiveRun(r.state))
    && (!query.since || Date.parse(r.queuedAt) >= Date.parse(query.since))),
  'GET /runs/:id/transcript': ({ params }) => f.runEvents[params.id] ?? [],
  // Interrupted, holding its task until the human resumes it
  'POST /runs/:id/stop': ({ params }) => {
    const run = f.runs.find(r => r.id === params.id) ?? notFound()
    if (!isActiveRun(run.state)) throw new ApiError(409, { code: 'conflict', constraint: 'run_not_active' }, 'Conflict: run not active')
    Object.assign(run, { state: 'interrupted', endedAt: new Date().toISOString() })
    emit({ type: 'run.updated', run })
    const task = f.tasks.find(t => t.id === run.taskId)
    if (task) {
      Object.assign(task, { paused: true, updatedAt: new Date().toISOString() })
      emit({ type: 'task.updated', task })
    }
    return run
  },
  // A mid-run message: kept as a comment, then the "runner" delivers it and
  // the agent answers, through the same live events as the server's
  'POST /projects/:slug/runs/:runId/messages': ({ params, body }) => {
    const run = f.runs.find(r => r.id === params.runId && r.projectId === project(params.slug).id) ?? notFound()
    const comment = { id: `cm-${Date.now()}`, taskId: run.taskId!, author: { kind: 'human' as const, userId: f.profile.id }, body: body.text.trim(), pinned: false, createdAt: new Date().toISOString() }
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
  },

  'POST /deployments/:id/read': ({ params }) => {
    const item = f.releaseNotes.find(r => r.deploymentId === params.id) ?? notFound()
    item.unread = false
    const deployment = releaseDeployment(item)
    emit({ type: 'deployment.updated', deployment, markedRead: true })
    return deployment
  },
  'POST /deployments/:id/dismiss': ({ params }) => {
    const item = f.releaseNotes.find(r => r.deploymentId === params.id) ?? notFound()
    item.unread = false
    item.resolution = 'You dismissed these release notes'
    const deployment = releaseDeployment(item)
    emit({ type: 'deployment.updated', deployment })
    return deployment
  },
  'GET /inbox': () => f.inbox(),
  'POST /inbox/read': ({ body }) => {
    f.readItems.add(body.id)
    emit({ type: 'inbox.read', itemType: body.type, id: body.id })
    return { ok: true }
  },
  // Let the static Inbox exercise send and auto-advance without a server.
  'POST /inbox/:taskId/actions': ({ params, body: input }) => {
    const task = f.tasks.find(t => t.id === params.taskId) ?? notFound()
    if (input.action !== 'approve' && input.action !== 'request_changes') {
      if (input.action === 'delete') f.tasks.splice(f.tasks.indexOf(task), 1)
      else task.status = input.action === 'send_back' ? 'backlog' : input.action === 'resolve' ? input.to : 'in_progress'
      emit(input.action === 'delete' ? { type: 'task.deleted', taskId: task.id, projectId: task.projectId } : { type: 'task.updated', task })
      return { task: input.action === 'delete' ? null : task }
    }
    const item = f.inbox().needsYou.find(i => i.taskId === task.id)
    if (!item || !('taskId' in item) || !item.taskId || task.status !== 'human_review') {
      throw new ApiError(409, { code: 'conflict', constraint: null }, 'This review is no longer actionable')
    }
    const accepted = input.action === 'approve'
    const now = new Date().toISOString()
    const approvedDesign = accepted && task.type === 'design'
    Object.assign(task, { status: approvedDesign ? 'approved' : accepted ? 'merged' : 'in_progress', mergedAt: accepted && !approvedDesign ? now : null, updatedAt: now })
    if (input.action === 'request_changes') {
      const comment = { id: `cm-${Date.now()}`, taskId: task.id, author: { kind: 'human' as const, userId: f.profile.id }, body: input.text, pinned: false, createdAt: now }
      ;(f.comments[task.id] ??= []).push(comment)
      emit({ type: 'comment.created', comment })
      task.statusReason = null
    }
    const resolution = approvedDesign ? 'You approved the design' : accepted ? (task.type === 'spike' ? 'You accepted the findings' : 'You approved the merge') : 'You requested changes'
    f.resolvedInbox.unshift({ ...item, message: undefined, since: undefined, newArtifacts: undefined, id: `resolved-${task.id}-${Date.now()}`, type: 'activity', sender: { name: 'You', role: 'system' }, body: resolution, preview: resolution, resolution, at: now })
    emit({ type: 'task.updated', task })
    return { task }
  },

  'POST /plan/sessions': ({ body }) => {
    const { id = crypto.randomUUID(), projectId = null, text = '', runtime = DEFAULT_AGENT_RUNTIME, taskRef } = body
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
  },
  'GET /plan/sessions': () => f.planSessions,
  'GET /plan/sessions/:id': ({ params }) => session(params.id),
  'GET /projects/:slug/drafts': ({ params }) => drafts(project(params.slug).id),
  // Approving moves the plan's Drafts to Ready or the Backlog
  'POST /plan/plans/:id/approve': ({ params, body }) => {
    const plan = Object.values(f.plans).flat().find(p => p.id === params.id) ?? notFound()
    const to = body?.to ?? 'ready'
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
  },
  // Closing discards only Drafts and unapproved plans, as the real endpoint does.
  'POST /plan/sessions/:id/close': ({ params }) => {
    const s = f.planSessions.find(x => x.id === params.id) ?? notFound()
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
    if (s.projectId) emit({ type: 'plan.drafts', projectId: s.projectId, sessions: drafts(s.projectId) })
    return s
  },
  // Decides a confirm card as the real endpoint does, without running the tool
  'POST /plan/sessions/:id/actions/:actionId': ({ params, body }) => {
    const s = f.planSessions.find(x => x.id === params.id) ?? notFound()
    const message = f.planMessages[s.id]?.find(m => m.id === params.actionId && m.pendingAction) ?? notFound()
    const action = message.pendingAction!
    if (action.status !== 'pending') return message
    Object.assign(action, body.decision === 'confirm' ? { status: 'confirmed', result: 'Done.' } : { status: 'cancelled' })
    emit({ type: 'plan.message', message })
    postMessage(s.id, { role: 'pm', kind: 'action_result', text: body.decision === 'confirm' ? `Confirmed: ${action.summary}. Done.` : `Cancelled: ${action.summary}. Nothing was changed.` })
    emit({ type: 'plan.session', session: Object.assign(s, { unread: true, updatedAt: new Date().toISOString() }) })
    return message
  },
  'POST /plan/sessions/:id/read': ({ params }) => {
    const s = Object.assign(f.planSessions.find(s => s.id === params.id) ?? notFound(), { unread: false })
    emit({ type: 'plan.session', session: s, markedRead: true })
    return s
  },
  'POST /plan/sessions/:id/messages': ({ params, body }) => {
    const s = f.planSessions.find(x => x.id === params.id) ?? notFound()
    const { text = '' } = body
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
  }
}

// Answers one call as the server would. Bodies and answers are copied both
// ways, as if over the wire, so pages and fixtures stay apart.
export async function mockCall<K extends WebEndpoint>(key: K, request: Partial<MockRequest<K>> = {}): Promise<EndpointResponse<K>> {
  const copy = <T>(value: T): T => value === undefined || value instanceof Blob || value instanceof FormData ? value : JSON.parse(JSON.stringify(value)) as T
  const handle = routes[key] as (request: MockRequest<K>) => EndpointResponse<K> | Promise<EndpointResponse<K>>
  const result = await handle({ params: request.params ?? {}, body: copy(request.body), query: copy(request.query ?? {}) } as MockRequest<K>)
  return copy(result)
}
