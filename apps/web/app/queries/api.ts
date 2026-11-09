import { transitionReason, type AgentRuntime, type PlanApprovalTarget } from '@corral/core'
import type { ApiErrorBody, CreateAgentInput, CreateProjectInput, CreateTaskInput, EndpointBody, EndpointParamName, EndpointParams, EndpointQuery, EndpointResponse, WebEndpoint, EpicReviewActionInput, FlowMetricsQuery, HumanTransitionInput, InboxActionInput, InboxReadInput, PatchAgentInput, PatchEpicInput, PatchProfileInput, PatchProjectInput, PatchTaskInput, PerfWindow, PmActionDecision } from '@corral/contracts'
import { ApiError } from './client'
import type { RunFilter } from './keys'

type Params<K extends WebEndpoint> = [EndpointParamName<K>] extends [never] ? { params?: undefined } : { params: EndpointParams<K, string | number> }
type Body<K extends WebEndpoint> = undefined extends EndpointBody<K> ? { body?: EndpointBody<K> } : { body: EndpointBody<K> }
type Query<K extends WebEndpoint> = undefined extends EndpointQuery<K> ? { query?: undefined } : { query: EndpointQuery<K> }
// What a call to an endpoint sends: path parameters, JSON or raw body, query.
// keepalive outlives the page, for a request sent as it unloads.
type ApiRequest<K extends WebEndpoint> = Params<K> & Body<K> & Query<K> & { keepalive?: boolean }

type Optional<K extends WebEndpoint> = object extends ApiRequest<K> ? [request?: ApiRequest<K>] : [request: ApiRequest<K>]

async function call<K extends WebEndpoint>(key: K, ...[request = {} as ApiRequest<K>]: Optional<K>): Promise<EndpointResponse<K>> {
  const { params = {}, body, query, keepalive } = request as { params?: Record<string, string | number>, body?: unknown, query?: Record<string, unknown>, keepalive?: boolean }
  const values = Object.fromEntries(Object.entries(params).map(([name, value]) => [name, String(value)]))
  // The static prototype answers from fixtures instead (app/prototype)
  if (import.meta.prototype) {
    const { mockCall } = await import('~/prototype/mock-api')
    return mockCall(key, { params: values, body, query } as never) as Promise<EndpointResponse<K>>
  }
  const [method, pattern] = key.split(' ') as [string, string]
  const path = pattern.replaceAll(/:(\w+)/g, (_, name: string) => encodeURIComponent(values[name]!))
  const search = new URLSearchParams(Object.entries(query ?? {}).flatMap(([name, value]) => value === undefined ? [] : [[name, String(value)]])).toString()
  // Multipart uploads let the browser set the boundary; blobs use their own type.
  const res = await fetch(`/api${path}${search ? `?${search}` : ''}`, {
    method,
    headers: body === undefined || body instanceof FormData ? {} : { 'content-type': body instanceof Blob ? body.type : 'application/json' },
    body: body === undefined ? undefined : body instanceof Blob || body instanceof FormData ? body : JSON.stringify(body),
    keepalive
  })
  if (res.status === 204) return undefined as EndpointResponse<K>
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // A page from something in front of the server, such as a proxy
    if (res.ok) throw new ApiError(res.status, null, `Unexpected response (${res.status})`)
    data = null
  }
  if (!res.ok) {
    const error = (data as ApiErrorBody | null)?.error ?? null
    throw new ApiError(res.status, error, describe(res.status, error))
  }
  return data as EndpointResponse<K>
}

function describe(status: number, error: ApiErrorBody['error'] | null): string {
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
    case 'transition_rejected': return transitionReason(error.reason)
    case 'invalid_dependencies': return `Invalid dependencies: ${JSON.stringify(error.problems)}`
    case 'plan_not_approvable': return error.problems.map(p => p.message).join(' ')
    case 'no_pull_request': return 'This task has no pull request yet'
    case 'pull_request_unavailable': return `GitHub couldn't return PR #${error.number}: ${error.message}`
    default: return `Request failed (${status})`
  }
}

// Everything web asks the server for. Only the server touches storage (D8).
export const api = {
  updateRunner: (id: string) => call('POST /runners/:runnerId/update', { params: { runnerId: id } }),
  runner: () => call('GET /runner'),
  status: () => call('GET /status'),
  stopAll: () => call('POST /stop-all'),
  liftUpdateHold: () => call('DELETE /update-hold'),
  resumeAll: () => call('POST /resume-all'),

  perfSummary: (window: PerfWindow) => call('GET /perf/summary', { query: { window } }),

  setup: {
    repos: (refresh = false) => call('GET /setup/repos', { query: refresh ? { refresh: '1' } : {} }),
    checkRepo: (repository: string) => call('POST /setup/check-repo', { body: { repository } }),
    clis: () => call('GET /setup/clis')
  },

  projects: {
    flow: (slug: string, window: FlowMetricsQuery['window']) => call('GET /projects/:slug/metrics/flow', { params: { slug }, query: { window } }),
    workspaceFlow: (window: FlowMetricsQuery['window']) => call('GET /metrics/flow', { query: { window } }),
    list: () => call('GET /projects'),
    create: (input: CreateProjectInput) => call('POST /projects', { body: input }),
    patch: (slug: string, input: PatchProjectInput) => call('PATCH /projects/:slug', { params: { slug }, body: input }),
    remove: (slug: string, confirm: string) => call('DELETE /projects/:slug', { params: { slug }, body: { confirm } }),
    setThumbnail: (slug: string, image: File) => {
      const form = new FormData()
      form.append('file', image)
      return call('PUT /projects/:slug/thumbnail', { params: { slug }, body: form })
    },
    clearThumbnail: (slug: string) => call('DELETE /projects/:slug/thumbnail', { params: { slug } }),
    // Open PRs and their merge gates, read live from GitHub
    pullRequests: (slug: string) => call('GET /projects/:slug/pull-requests', { params: { slug } }),
    pullRequest: (slug: string, number: number) => call('GET /projects/:slug/pull-requests/:number', { params: { slug, number } }),
    // A PR's guided review (COR-525): read it, or ask for one for the head commit
    pullRequestGuide: (slug: string, number: number) => call('GET /projects/:slug/pull-requests/:number/guide', { params: { slug, number } }),
    generatePullRequestGuide: (slug: string, number: number) => call('POST /projects/:slug/pull-requests/:number/guide', { params: { slug, number } })
  },

  tasks: {
    list: (slug: string) => call('GET /projects/:slug/tasks', { params: { slug }, query: { view: 'all' } }),
    byRef: (ref: string) => call('GET /tasks/:ref', { params: { ref } }),
    create: (slug: string, input: CreateTaskInput) => call('POST /projects/:slug/tasks', { params: { slug }, body: input }),
    addSubtask: (slug: string, number: number, input: CreateTaskInput) => call('POST /projects/:slug/tasks/:number/subtasks', { params: { slug, number }, body: input }),
    patch: (slug: string, number: number, input: PatchTaskInput) => call('PATCH /projects/:slug/tasks/:number', { params: { slug, number }, body: input }),
    remove: (slug: string, number: number, reason?: string) => call('DELETE /projects/:slug/tasks/:number', { params: { slug, number }, body: reason ? { reason } : undefined }),
    transition: (slug: string, number: number, input: HumanTransitionInput) => call('POST /projects/:slug/tasks/:number/transitions', { params: { slug, number }, body: input }),
    resume: (slug: string, number: number) => call('POST /projects/:slug/tasks/:number/resume', { params: { slug, number } }),
    comments: (slug: string, number: number) => call('GET /projects/:slug/tasks/:number/comments', { params: { slug, number } }),
    comment: (slug: string, number: number, body: string, pinned = false) => call('POST /projects/:slug/tasks/:number/comments', { params: { slug, number }, body: { body, pinned } }),
    history: (slug: string, number: number) => call('GET /projects/:slug/tasks/:number/history', { params: { slug, number } }),
    evidence: (slug: string, number: number) => call('GET /projects/:slug/tasks/:number/evidence', { params: { slug, number } }),
    reviews: (slug: string, number: number) => call('GET /projects/:slug/tasks/:number/reviews', { params: { slug, number } }),
    designs: (slug: string, number: number) => call('GET /projects/:slug/tasks/:number/designs', { params: { slug, number } }),
    approveDesign: (slug: string, number: number, version: number, note?: string) => call('POST /projects/:slug/tasks/:number/designs/:version/approve', { params: { slug, number, version }, body: { note } })
  },

  attachments: {
    // An image for task text; referenced as ![name](attachment:<id>)
    upload: (slug: string, file: Blob, name: string) => call('POST /projects/:slug/attachments', { params: { slug }, body: file, query: { name } })
  },

  agents: {
    list: () => call('GET /agents'),
    create: (input: CreateAgentInput) => call('POST /agents', { body: input }),
    patch: (id: string, input: PatchAgentInput) => call('PATCH /agents/:id', { params: { id }, body: input }),
    setAvatar: (id: string, image: Blob) => call('PUT /agents/:id/avatar', { params: { id }, body: image }),
    clearAvatar: (id: string) => call('DELETE /agents/:id/avatar', { params: { id } })
  },
  me: {
    get: () => call('GET /me'),
    patch: (input: PatchProfileInput) => call('PATCH /me', { body: input }),
    setAvatar: (image: Blob) => call('PUT /me/avatar', { body: image }),
    clearAvatar: () => call('DELETE /me/avatar')
  },

  runs: {
    list: ({ since, agentId, taskId, active }: RunFilter = {}) => call('GET /runs', { query: { since, agentId, taskId, active: active ? '1' : undefined } }),
    transcript: (id: string) => call('GET /runs/:id/transcript', { params: { id } }),
    stop: (id: string) => call('POST /runs/:id/stop', { params: { id } }),
    // A message to a live developer or reviewer run, kept as a comment on its task
    message: (slug: string, runId: string, text: string) => call('POST /projects/:slug/runs/:runId/messages', { params: { slug, runId }, body: { text } })
  },

  deployments: {
    read: (id: string) => call('POST /deployments/:id/read', { params: { id } }),
    dismiss: (id: string) => call('POST /deployments/:id/dismiss', { params: { id } })
  },

  inbox: {
    get: () => call('GET /inbox'),
    act: (taskId: string, input: InboxActionInput) => call('POST /inbox/:taskId/actions', { params: { taskId }, body: input }),
    read: (input: InboxReadInput) => call('POST /inbox/read', { body: input })
  },

  epics: {
    activity: (id: string) => call('GET /epics/:id/activity', { params: { id } }),
    getReview: (id: string) => call('GET /epics/:id/review', { params: { id } }),
    review: (id: string, input: EpicReviewActionInput) => call('POST /epics/:id/review', { params: { id }, body: input }),
    retrySync: (id: string) => call('POST /epics/:id/sync/retry', { params: { id } }),
    setDependencies: (id: string, dependsOn: string[]) => call('PUT /epics/:id/dependencies', { params: { id }, body: { dependsOn } }),
    list: (slug: string) => call('GET /projects/:slug/epics', { params: { slug } }),
    get: (id: string) => call('GET /epics/:id', { params: { id } }),
    history: (id: string) => call('GET /epics/:id/history', { params: { id } }),
    patch: (id: string, input: PatchEpicInput) => call('PATCH /epics/:id', { params: { id }, body: input })
  },
  plan: {
    resolveAction: (sessionId: string, actionId: string, decision: PmActionDecision) => call('POST /plan/sessions/:id/actions/:actionId', { params: { id: sessionId, actionId }, body: { decision } }),
    sessions: () => call('GET /plan/sessions'),
    session: (id: string) => call('GET /plan/sessions/:id', { params: { id } }),
    start: (projectId: string | null, text: string, taskRef?: string, runtime?: AgentRuntime, id?: string) => call('POST /plan/sessions', { body: { projectId, text, ...(id && { id }), ...(taskRef && { taskRef }), ...(runtime && { runtime }) } }),
    message: (id: string, text: string, taskRef?: string) => call('POST /plan/sessions/:id/messages', { params: { id }, body: { text, ...(taskRef && { taskRef }) } }),
    close: (id: string, options?: { keepalive?: boolean }) => call('POST /plan/sessions/:id/close', { params: { id }, ...options }),
    read: (id: string) => call('POST /plan/sessions/:id/read', { params: { id } }),
    approve: (planId: string, to: PlanApprovalTarget) => call('POST /plan/plans/:id/approve', { params: { id: planId }, body: { to } }),
    drafts: (slug: string) => call('GET /projects/:slug/drafts', { params: { slug } })
  }
}
