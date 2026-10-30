import type {
  Agent,
  AgentRuntime,
  ApiErrorBody,
  Attachment,
  DraftSession,
  AuditEntry,
  CliStatus,
  Comment,
  CreateProjectInput,
  CreateTaskInput,
  DesignVersion,
  Epic,
  EpicDetail,
  EpicReviewActionInput,
  Evidence,
  GlobalStatus,
  ServerStatus,
  HumanTransitionInput,
  Inbox,
  InboxActionInput,
  CreateAgentInput,
  PatchAgentInput,
  PatchEpicInput,
  PatchProfileInput,
  PatchProjectInput,
  PatchTaskInput,
  Plan,
  PlanMessage,
  PlanSession,
  PlanSessionDetail,
  Profile,
  Project,
  PullRequestStatus,
  RepoCheck,
  RepoList,
  Review,
  Run,
  RunMessageAccepted,
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

async function call<T>(method: string, path: string, body?: unknown, options?: { keepalive?: boolean }): Promise<T> {
  // The static prototype answers from fixtures instead (app/prototype)
  if (import.meta.prototype) {
    const { mockCall } = await import('~/prototype/mock-api')
    return mockCall<T>(method, path, body)
  }
  // Multipart uploads let the browser set the boundary; blobs use their own type.
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined || body instanceof FormData ? {} : { 'content-type': body instanceof Blob ? body.type : 'application/json' },
    body: body === undefined ? undefined : body instanceof Blob || body instanceof FormData ? body : JSON.stringify(body),
    // Outlives the page, for a request sent as it unloads
    keepalive: options?.keepalive
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
    case 'corral_updating': return 'Corral is updating; try again in a few minutes'
    case 'run_not_live': return error.reason
    case 'invalid_input': {
      // The first issue says what to fix, e.g. "The image is over 2 MB"
      const first = Array.isArray(error.issues) ? (error.issues[0] as { message?: unknown } | undefined)?.message : undefined
      return typeof first === 'string' ? first : 'Some of the input is invalid'
    }
    case 'forbidden': return 'Only a human can do that'
    case 'conflict': return error.constraint ? `Conflict: ${error.constraint.replaceAll('_', ' ')}` : 'Conflict'
    case 'transition_rejected': return `Not allowed: ${JSON.stringify(error.reason)}`
    case 'invalid_dependencies': return `Invalid dependencies: ${JSON.stringify(error.problems)}`
    case 'plan_not_approvable': return error.problems.map(p => p.message).join(' ')
    default: return `Request failed (${status})`
  }
}

// Everything web asks the server for. Only the server touches storage (D8).
export const api = {
  health: () => call<{ ok: boolean }>('GET', '/health'),
  runner: () => call<RunnerStatus>('GET', '/runner'),
  status: () => call<ServerStatus>('GET', '/status'),
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
    patch: (slug: string, input: PatchProjectInput) => call<Project>('PATCH', `/projects/${slug}`, input),
    remove: (slug: string, confirm: string) => call<null>('DELETE', `/projects/${slug}`, { confirm }),
    setThumbnail: (slug: string, image: File) => {
      const form = new FormData()
      form.append('file', image)
      return call<Project>('PUT', `/projects/${slug}/thumbnail`, form)
    },
    clearThumbnail: (slug: string) => call<Project>('DELETE', `/projects/${slug}/thumbnail`),
    // Open PRs and their merge gates, read live from GitHub
    pullRequests: (slug: string) => call<PullRequestStatus[]>('GET', `/projects/${slug}/pull-requests`)
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
    resume: (slug: string, number: number) => call<Task>('POST', `/projects/${slug}/tasks/${number}/resume`),
    comments: (slug: string, number: number) => call<Comment[]>('GET', `/projects/${slug}/tasks/${number}/comments`),
    comment: (slug: string, number: number, body: string, pinned = false) => call<Comment>('POST', `/projects/${slug}/tasks/${number}/comments`, { body, pinned }),
    history: (slug: string, number: number) => call<AuditEntry[]>('GET', `/projects/${slug}/tasks/${number}/history`),
    evidence: (slug: string, number: number) => call<Evidence[]>('GET', `/projects/${slug}/tasks/${number}/evidence`),
    reviews: (slug: string, number: number) => call<Review[]>('GET', `/projects/${slug}/tasks/${number}/reviews`),
    designs: (slug: string, number: number) => call<DesignVersion[]>('GET', `/projects/${slug}/tasks/${number}/designs`),
    approveDesign: (slug: string, number: number, version: number, note?: string) => call<Task>('POST', `/projects/${slug}/tasks/${number}/designs/${version}/approve`, { note })
  },

  attachments: {
    // An image for task text; referenced as ![name](attachment:<id>)
    upload: (slug: string, file: Blob, name: string) => call<Attachment>('POST', `/projects/${slug}/attachments?name=${encodeURIComponent(name)}`, file)
  },

  agents: {
    list: () => call<Agent[]>('GET', '/agents'),
    create: (input: CreateAgentInput) => call<Agent>('POST', '/agents', input),
    patch: (id: string, input: PatchAgentInput) => call<Agent>('PATCH', `/agents/${id}`, input),
    setAvatar: (id: string, image: Blob) => call<Agent>('PUT', `/agents/${id}/avatar`, image),
    clearAvatar: (id: string) => call<Agent>('DELETE', `/agents/${id}/avatar`)
  },
  me: {
    get: () => call<Profile>('GET', '/me'),
    patch: (input: PatchProfileInput) => call<Profile>('PATCH', '/me', input),
    setAvatar: (image: Blob) => call<Profile>('PUT', '/me/avatar', image),
    clearAvatar: () => call<Profile>('DELETE', '/me/avatar')
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
    stop: (id: string) => call<Run>('POST', `/runs/${id}/stop`),
    // A message to a live developer or reviewer run, kept as a comment on its task
    message: (slug: string, id: string, text: string) => call<RunMessageAccepted>('POST', `/projects/${slug}/runs/${id}/messages`, { text })
  },

  deployments: {
    read: (id: string) => call('POST', `/deployments/${id}/read`),
    dismiss: (id: string) => call('POST', `/deployments/${id}/dismiss`)
  },

  inbox: {
    get: () => call<Inbox>('GET', '/inbox'),
    act: (taskId: string, input: InboxActionInput) => call<{ task: Task | null }>('POST', `/inbox/${taskId}/actions`, input)
  },

  epics: {
    review: (id: string, input: EpicReviewActionInput) => call<{ ok: boolean }>('POST', `/epics/${id}/review`, input),
    setDependencies: (id: string, dependsOn: string[]) => call<Epic>('PUT', `/epics/${id}/dependencies`, { dependsOn }),
    list: (slug: string) => call<Epic[]>('GET', `/projects/${slug}/epics`),
    get: (id: string) => call<EpicDetail>('GET', `/epics/${id}`),
    patch: (id: string, input: PatchEpicInput) => call<Epic>('PATCH', `/epics/${id}`, input)
  },
  plan: {
    sessions: () => call<PlanSession[]>('GET', '/plan/sessions'),
    session: (id: string) => call<PlanSessionDetail>('GET', `/plan/sessions/${id}`),
    start: (projectId: string, text: string, taskRef?: string, runtime?: AgentRuntime, id?: string) => call<PlanSessionDetail>('POST', '/plan/sessions', { projectId, text, ...(id && { id }), ...(taskRef && { taskRef }), ...(runtime && { runtime }) }),
    message: (id: string, text: string, taskRef?: string) => call<PlanMessage>('POST', `/plan/sessions/${id}/messages`, { text, ...(taskRef && { taskRef }) }),
    close: (id: string, options?: { keepalive?: boolean }) => call<PlanSession>('POST', `/plan/sessions/${id}/close`, undefined, options),
    read: (id: string) => call<PlanSession>('POST', `/plan/sessions/${id}/read`),
    approve: (planId: string, to: 'ready' | 'backlog') => call<Plan>('POST', `/plan/plans/${planId}/approve`, { to }),
    discard: (planId: string) => call<Plan>('POST', `/plan/plans/${planId}/discard`),
    drafts: (slug: string) => call<DraftSession[]>('GET', `/projects/${slug}/drafts`)
  }
}
