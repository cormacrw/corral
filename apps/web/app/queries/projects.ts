import { partialMatchKey, queryOptions } from '@tanstack/vue-query'
import type { CreateProjectInput, FlowMetricsQuery, PatchProjectInput, Project } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { clearProject, defineMutation, removedProjectStale } from './dependencies'
import { keys } from './keys'

export const PULL_REQUESTS_POLL_MS = 30_000
export const DEFAULT_FLOW_WINDOW = '30d' satisfies FlowMetricsQuery['window']

export const projectsQuery = () => queryOptions({ queryKey: keys.projects.list(), queryFn: () => api.projects.list() })
export const projectQuery = (slug: string) => queryOptions({ queryKey: keys.projects.detail(slug), queryFn: () => api.projects.get(slug) })
// Keeps the chart on screen while another window loads, but not another project's
export const flowQuery = (slug: string, window: FlowMetricsQuery['window']) => queryOptions({
  queryKey: keys.projects.flow(slug, window),
  queryFn: () => api.projects.flow(slug, window),
  placeholderData: (previous, query) => query && partialMatchKey(query.queryKey, keys.projects.flow(slug)) ? previous : undefined
})
// CI and the base branch move on GitHub without an event, so this polls, only
// while the tab is visible (refetchIntervalInBackground defaults to false)
export const pullRequestsQuery = (slug: string) => queryOptions({
  queryKey: keys.projects.pullRequests(slug),
  queryFn: () => api.projects.pullRequests(slug),
  refetchInterval: PULL_REQUESTS_POLL_MS
})

export const createProject = defineMutation<Project, CreateProjectInput>({
  mutationFn: input => api.projects.create(input),
  invalidates: [keys.projects.list(), keys.setup.repos()]
})
export const setProjectThumbnail = defineMutation<Project, { slug: string, image: File | null }>({
  mutationFn: ({ slug, image }) => image ? api.projects.setThumbnail(slug, image) : api.projects.clearThumbnail(slug),
  invalidates: (_, { slug }) => [keys.projects.list(), keys.projects.detail(slug)]
})
export const removeProject = defineMutation<null, { id: string, slug: string, confirm: string }>({
  mutationFn: ({ slug, confirm }) => api.projects.remove(slug, confirm),
  write: (client, _, { id }) => clearProject(client, id),
  invalidates: removedProjectStale
})
export const patchProject = defineMutation<Project, { slug: string, input: PatchProjectInput }>({
  mutationFn: ({ slug, input }) => api.projects.patch(slug, input),
  invalidates: (_, { slug }) => [keys.projects.list(), keys.projects.detail(slug)]
})
