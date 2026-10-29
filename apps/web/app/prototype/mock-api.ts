import type { Plan, PlanMessage, PlanSessionDetail, RunEvent, ServerEvent, Task } from '@corral/contracts'
import { ApiError } from '~/composables/useApi'
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
route('GET', '/runner', () => f.runner)
route('GET', '/status', () => f.status)
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

route('GET', '/projects', () => f.projects)
route('GET', '/projects/:slug', ([slug]) => project(slug!))
route('PATCH', '/projects/:slug', ([slug], body) => Object.assign(project(slug!), body))

route('GET', '/projects/:slug/tasks', ([slug], _, query) => {
  const p = project(slug!)
  const view = query.get('view') ?? 'all'
  return f.tasks.filter(t => t.projectId === p.id && t.status !== 'draft'
    && (view === 'all' || (view === 'backlog') === (t.status === 'backlog')))
})
route('GET', '/projects/:slug/tasks/:number', ([slug, number]) => taskIn(slug!, number!))
route('PATCH', '/projects/:slug/tasks/:number', ([slug, number], body) => Object.assign(taskIn(slug!, number!), body))
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
route('GET', '/projects/:slug/epics', ([slug]) => f.epics.filter(e => e.projectId === project(slug!).id))
route('GET', '/epics/:id', ([id]) => {
  const epic = f.epics.find(e => e.id === id) ?? notFound()
  return { ...epic, tasks: f.tasks.filter(t => t.epicId === epic.id) }
})

route('GET', '/agents', () => f.agents)
route('PATCH', '/agents/:id', ([id], body) => Object.assign(f.agents.find(a => a.id === id) ?? notFound(), body))
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
    ;(f.runEvents[run.id] ??= []).push(...events)
    emit({ type: 'run.events', runId: run.id, events })
  }
  setTimeout(() => deliver([{ type: 'message', text: comment.body }]), 300)
  setTimeout(() => deliver([{ type: 'message', text: 'Got it, I\'ll do that next.' }]), 1200)
  return { runId: run.id, comment }
})

route('GET', '/inbox', () => f.inbox())

route('GET', '/plan/sessions', () => f.planSessions)
route('GET', '/plan/sessions/:id', ([id]) => session(id!))
// Drafts by session: each session's latest plan, while it waits for approval
route('GET', '/projects/:slug/drafts', ([slug]) => f.planSessions
  .filter(s => s.projectId === project(slug!).id)
  .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  .flatMap((s) => {
    const latest = f.plans[s.id]?.at(-1)
    const drafts = latest?.status === 'proposed' ? latest.tasks.filter(t => t.status === 'draft') : []
    return drafts.length === 0
      ? []
      : [{ sessionId: s.id, title: s.title, updatedAt: s.updatedAt, planStatus: latest!.status, drafts: drafts.map(t => ({ taskId: t.taskId ?? t.key, ref: t.ref ?? t.key, title: t.title, type: 'task' as const, priority: t.priority })) }]
  }))
route('POST', '/plan/sessions/:id/read', ([id]) => Object.assign(f.planSessions.find(s => s.id === id) ?? notFound(), { unread: false }))

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
function postMessage(sessionId: string, message: Omit<PlanMessage, 'id' | 'sessionId' | 'createdAt' | 'runId' | 'planId' | 'recommendation' | 'options'> & Partial<PlanMessage>): PlanMessage {
  const m: PlanMessage = { recommendation: null, options: null, planId: null, runId: null, ...message, id: `mock-m-${++nextId}`, sessionId, createdAt: new Date().toISOString() }
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
    postMessage(sessionId, { role: 'pm', kind: 'message', text: summary, planId: plan.id })
    Object.assign(s, { status: 'needs_approval', preview: summary, updatedAt: new Date().toISOString() })
  }
  emit({ type: 'plan.session', session: s })
}

route('POST', '/plan/sessions/:id/messages', ([id], body) => {
  const s = f.planSessions.find(x => x.id === id) ?? notFound()
  const { text } = body as { text: string }
  const message = postMessage(s.id, { role: 'human', kind: 'message', text })
  setTimeout(() => pmReply(s.id, text), 1000)
  return message
})

export async function mockCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const [pathname = '', search] = path.split('?')
  for (const [m, pattern, handler] of routes) {
    const match = m === method ? pattern.exec(pathname) : null
    if (!match) continue
    const params = match.slice(1).map(decodeURIComponent)
    // Copies both ways, as if over the wire, so pages and fixtures stay apart
    const input: unknown = body === undefined || body instanceof Blob ? body : JSON.parse(JSON.stringify(body))
    const result = handler(params, input, new URLSearchParams(search))
    return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as T
  }
  notFound()
}
