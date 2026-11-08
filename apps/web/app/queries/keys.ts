import type { FlowMetricsQuery, PerfWindow } from '@corral/contracts'

export interface RunFilter {
  agentId?: string
  taskId?: string
  active?: boolean
  // Every run queued since this ISO time, not just the latest page
  since?: string
}

// Every query key in one hierarchy, so invalidating a key covers everything
// under it. Never write a key by hand (wiki: query-layer).
export const keys = {
  projects: {
    all: () => ['projects'] as const,
    list: () => [...keys.projects.all(), 'list'] as const,
    detail: (slug: string) => [...keys.projects.all(), 'detail', slug] as const,
    flow: (slug: string, window?: FlowMetricsQuery['window']) => [...keys.projects.detail(slug), 'flow', ...(window ? [window] : [])] as const,
    pullRequests: (slug: string) => [...keys.projects.detail(slug), 'pull-requests'] as const,
    // Cycle time across every project (Home)
    workspaceFlow: (window?: FlowMetricsQuery['window']) => [...keys.projects.all(), 'workspace-flow', ...(window ? [window] : [])] as const
  },
  tasks: {
    all: () => ['tasks'] as const,
    lists: () => [...keys.tasks.all(), 'list'] as const,
    list: (slug: string) => [...keys.tasks.lists(), slug] as const,
    details: () => [...keys.tasks.all(), 'detail'] as const,
    detail: (ref: string) => [...keys.tasks.details(), ref] as const,
    comments: (ref: string) => [...keys.tasks.detail(ref), 'comments'] as const,
    history: (ref: string) => [...keys.tasks.detail(ref), 'history'] as const,
    evidence: (ref: string) => [...keys.tasks.detail(ref), 'evidence'] as const,
    reviews: (ref: string) => [...keys.tasks.detail(ref), 'reviews'] as const,
    designs: (ref: string) => [...keys.tasks.detail(ref), 'designs'] as const,
    pullRequests: (ref: string) => [...keys.tasks.detail(ref), 'pull-request'] as const,
    pullRequest: (ref: string, number: number) => [...keys.tasks.pullRequests(ref), number] as const,
    // Under its PR, so a push that ends a run refreshes it too
    pullRequestGuide: (ref: string, number: number) => [...keys.tasks.pullRequest(ref, number), 'guide'] as const
  },
  epics: {
    all: () => ['epics'] as const,
    lists: () => [...keys.epics.all(), 'list'] as const,
    list: (slug: string) => [...keys.epics.lists(), slug] as const,
    details: () => [...keys.epics.all(), 'detail'] as const,
    detail: (id: string) => [...keys.epics.details(), id] as const,
    activity: (id: string) => [...keys.epics.detail(id), 'activity'] as const,
    review: (id: string) => [...keys.epics.detail(id), 'review'] as const,
    history: (id: string) => [...keys.epics.detail(id), 'history'] as const
  },
  agents: {
    all: () => ['agents'] as const,
    list: () => [...keys.agents.all(), 'list'] as const
  },
  runs: {
    all: () => ['runs'] as const,
    lists: () => [...keys.runs.all(), 'list'] as const,
    list: (filter: RunFilter = {}) => [...keys.runs.lists(), filter] as const,
    transcript: (id: string) => [...keys.runs.all(), 'transcript', id] as const
  },
  plan: {
    all: () => ['plan'] as const,
    sessions: () => [...keys.plan.all(), 'sessions'] as const,
    session: (id: string) => [...keys.plan.sessions(), id] as const,
    // Threads started here that the server may not have yet: client state, never fetched
    starts: () => [...keys.plan.all(), 'starts'] as const,
    drafts: (slug: string) => [...keys.plan.all(), 'drafts', slug] as const
  },
  setup: {
    all: () => ['setup'] as const,
    clis: () => [...keys.setup.all(), 'clis'] as const,
    repos: () => [...keys.setup.all(), 'repos'] as const
  },
  inbox: () => ['inbox'] as const,
  // A mutation key: what's running, not cached data
  inboxResolving: () => ['inbox', 'resolving'] as const,
  performance: (window: PerfWindow) => ['performance', window] as const,
  profile: () => ['profile'] as const,
  runner: () => ['runner'] as const,
  status: () => ['status'] as const
}

// What the cache holds for a project, so removing one finds all of it
// (clearProject). A query holding project data belongs in one of these.
export const projectData = {
  bySlug: (slug: string) => [keys.projects.detail(slug), keys.tasks.list(slug), keys.epics.list(slug), keys.plan.drafts(slug)],
  // Entities that name it by projectId (task details and run transcripts are
  // found through the cached tasks and runs)
  owned: [keys.epics.details(), keys.plan.sessions()],
  // Lists across projects, which lose its rows and stay
  spanning: [keys.runs.lists(), keys.plan.sessions()],
  // Refetched once it's gone: a fetch in flight started before the removal and
  // would bring it back. Repository rows name the project using them.
  listing: [keys.projects.list(), keys.inbox(), keys.tasks.lists(), keys.epics.lists(), keys.plan.all(), keys.runs.lists(), keys.setup.repos()]
}

// Entries shown before the server has them (a comment, the first message of a
// Plan start) carry a temporary id, which the server's own entry replaces
export const pendingId = (id: string = crypto.randomUUID()) => `pending-${id}`
export const isPendingId = (id: string) => id.startsWith('pending-')
