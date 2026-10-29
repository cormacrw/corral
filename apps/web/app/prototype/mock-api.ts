import type { PlanSessionDetail, Task } from '@corral/contracts'
import { ApiError } from '~/composables/useApi'
import * as f from './fixtures'

// The server API for the static prototype (`pnpm prototype`, D20): the same
// paths useApi calls, answered from ./fixtures in memory. Reads return the
// fixtures; writes change them for the session so clicks show their result,
// and reload resets everything. A path nobody handles is a 404, as on the
// server, so a page's error state shows instead of a crash.

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

route('GET', '/inbox', () => f.inbox())

route('GET', '/plan/sessions', () => f.planSessions)
route('GET', '/plan/sessions/:id', ([id]) => session(id!))
route('POST', '/plan/sessions/:id/read', ([id]) => Object.assign(f.planSessions.find(s => s.id === id) ?? notFound(), { unread: false }))

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
