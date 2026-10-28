import type {
  Agent,
  ApiErrorBody,
  AuditEntry,
  CliStatus,
  Comment,
  CreateProjectInput,
  CreateTaskInput,
  Evidence,
  GlobalStatus,
  HumanTransitionInput,
  Inbox,
  InboxActionInput,
  PatchAgentInput,
  PatchProjectInput,
  PatchTaskInput,
  Plan,
  PlanMessage,
  PlanSession,
  PlanSessionDetail,
  Project,
  RepoCheck,
  RepoList,
  Review,
  Run,
  RunnerStatus,
  RunEvent,
  Task
} from '@corral/contracts'

// An API failure, with the server's structured error when there is one
export class ApiError extends Error {
  status: number
  body: ApiErrorBody['error'] | null

  constructor(status: number, body: ApiErrorBody['error'] | null, message: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const error = (data as ApiErrorBody | null)?.error ?? null
    throw new ApiError(res.status, error, describe(res.status, error))
  }
  return data as T
}

export function describe(status: number, error: ApiErrorBody['error'] | null): string {
  if (!error) return `Request failed (${status})`
  switch (error.code) {
    case 'not_found': return 'Not found'
    case 'runner_offline': return 'The runner is offline'
    case 'invalid_input': return 'Some of the input is invalid'
    case 'conflict': return error.constraint ? `Conflict: ${error.constraint.replaceAll('_', ' ')}` : 'Conflict'
    case 'transition_rejected': return `Not allowed: ${JSON.stringify(error.reason)}`
    case 'invalid_dependencies': return `Invalid dependencies: ${JSON.stringify(error.problems)}`
    default: return `Request failed (${status})`
  }
}

// Everything web asks the server for. Only the server touches storage (D8).
export const api = {
  health: () => call<{ ok: boolean }>('GET', '/health'),
  runner: () => call<RunnerStatus>('GET', '/runner'),
  status: () => call<GlobalStatus>('GET', '/status'),
  stopAll: () => call<GlobalStatus>('POST', '/stop-all'),
  resumeAll: () => call<GlobalStatus>('POST', '/resume-all'),

  setup: {
    repos: (refresh = false) => call<RepoList>('GET', `/setup/repos${refresh ? '?refresh=1' : ''}`),
    checkRepo: (repository: string) => call<RepoCheck>('POST', '/setup/check-repo', { repository }),
    clis: () => call<CliStatus[]>('GET', '/setup/clis')
  },

  projects: {
    list: () => call<Project[]>('GET', '/projects'),
    get: (slug: string) => call<Project>('GET', `/projects/${slug}`),
    create: (input: CreateProjectInput) => call<Project>('POST', '/projects', input),
    patch: (slug: string, input: PatchProjectInput) => call<Project>('PATCH', `/projects/${slug}`, input)
  },

  tasks: {
    list: (slug: string, view: 'board' | 'backlog' | 'all' = 'all') => call<Task[]>('GET', `/projects/${slug}/tasks?view=${view}`),
    get: (slug: string, number: number) => call<Task>('GET', `/projects/${slug}/tasks/${number}`),
    byRef: (ref: string) => call<Task>('GET', `/tasks/${ref}`),
    create: (slug: string, input: CreateTaskInput) => call<Task>('POST', `/projects/${slug}/tasks`, input),
    patch: (slug: string, number: number, input: PatchTaskInput) => call<Task>('PATCH', `/projects/${slug}/tasks/${number}`, input),
    remove: (slug: string, number: number, reason?: string) => call<null>('DELETE', `/projects/${slug}/tasks/${number}`, reason ? { reason } : undefined),
    transition: (slug: string, number: number, input: HumanTransitionInput) => call<Task>('POST', `/projects/${slug}/tasks/${number}/transitions`, input),
    approve: (slug: string, number: number) => call<Task>('POST', `/projects/${slug}/tasks/${number}/approve`),
    comments: (slug: string, number: number) => call<Comment[]>('GET', `/projects/${slug}/tasks/${number}/comments`),
    comment: (slug: string, number: number, body: string, pinned = false) => call<Comment>('POST', `/projects/${slug}/tasks/${number}/comments`, { body, pinned }),
    history: (slug: string, number: number) => call<AuditEntry[]>('GET', `/projects/${slug}/tasks/${number}/history`),
    evidence: (slug: string, number: number) => call<Evidence[]>('GET', `/projects/${slug}/tasks/${number}/evidence`),
    reviews: (slug: string, number: number) => call<Review[]>('GET', `/projects/${slug}/tasks/${number}/reviews`)
  },

  agents: {
    list: () => call<Agent[]>('GET', '/agents'),
    patch: (id: string, input: PatchAgentInput) => call<Agent>('PATCH', `/agents/${id}`, input)
  },

  runs: {
    list: (filter: { agentId?: string, taskId?: string, active?: boolean } = {}) => {
      const query = new URLSearchParams()
      if (filter.agentId) query.set('agentId', filter.agentId)
      if (filter.taskId) query.set('taskId', filter.taskId)
      if (filter.active) query.set('active', '1')
      const text = query.toString()
      return call<Run[]>('GET', `/runs${text ? `?${text}` : ''}`)
    },
    get: (id: string) => call<Run>('GET', `/runs/${id}`),
    transcript: (id: string) => call<RunEvent[]>('GET', `/runs/${id}/transcript`),
    stop: (id: string) => call<Run>('POST', `/runs/${id}/stop`)
  },

  inbox: {
    get: () => call<Inbox>('GET', '/inbox'),
    act: (taskId: string, input: InboxActionInput) => call<{ task: Task | null }>('POST', `/inbox/${taskId}/actions`, input)
  },

  plan: {
    sessions: () => call<PlanSession[]>('GET', '/plan/sessions'),
    session: (id: string) => call<PlanSessionDetail>('GET', `/plan/sessions/${id}`),
    start: (projectId: string, text: string, taskRef?: string) => call<PlanSessionDetail>('POST', '/plan/sessions', { projectId, text, ...(taskRef && { taskRef }) }),
    message: (id: string, text: string, taskRef?: string) => call<PlanMessage>('POST', `/plan/sessions/${id}/messages`, { text, ...(taskRef && { taskRef }) }),
    read: (id: string) => call<PlanSession>('POST', `/plan/sessions/${id}/read`),
    approve: (planId: string) => call<Plan>('POST', `/plan/plans/${planId}/approve`)
  }
}
