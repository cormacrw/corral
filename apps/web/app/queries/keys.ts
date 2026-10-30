import type { FlowMetricsQuery } from '@corral/contracts'

export interface RunFilter {
  agentId?: string
  taskId?: string
  active?: boolean
}

// Every query key in one hierarchy, so invalidating a key covers everything
// under it. Never write a key by hand (wiki: query-layer).
export const keys = {
  projects: {
    all: () => ['projects'] as const,
    list: () => [...keys.projects.all(), 'list'] as const,
    detail: (slug: string) => [...keys.projects.all(), 'detail', slug] as const,
    flow: (slug: string, window?: FlowMetricsQuery['window']) => [...keys.projects.detail(slug), 'flow', ...(window ? [window] : [])] as const,
    pullRequests: (slug: string) => [...keys.projects.detail(slug), 'pull-requests'] as const
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
    designs: (ref: string) => [...keys.tasks.detail(ref), 'designs'] as const
  },
  epics: {
    all: () => ['epics'] as const,
    lists: () => [...keys.epics.all(), 'list'] as const,
    list: (slug: string) => [...keys.epics.lists(), slug] as const,
    details: () => [...keys.epics.all(), 'detail'] as const,
    detail: (id: string) => [...keys.epics.details(), id] as const,
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
    detail: (id: string) => [...keys.runs.all(), 'detail', id] as const,
    transcript: (id: string) => [...keys.runs.detail(id), 'transcript'] as const
  },
  plan: {
    all: () => ['plan'] as const,
    sessions: () => [...keys.plan.all(), 'sessions'] as const,
    session: (id: string) => [...keys.plan.sessions(), id] as const,
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
  profile: () => ['profile'] as const,
  runner: () => ['runner'] as const,
  status: () => ['status'] as const
}
