import { queryOptions } from '@tanstack/vue-query'
import type { CreateProjectInput, FlowMetricsQuery, PatchProjectInput, Project } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import { keys } from './keys'

export const projectsQuery = () => queryOptions({ queryKey: keys.projects.list(), queryFn: () => api.projects.list() })
export const projectQuery = (slug: string) => queryOptions({ queryKey: keys.projects.detail(slug), queryFn: () => api.projects.get(slug) })
export const flowQuery = (slug: string, window: FlowMetricsQuery['window']) => queryOptions({ queryKey: keys.projects.flow(slug, window), queryFn: () => api.projects.flow(slug, window) })
export const pullRequestsQuery = (slug: string) => queryOptions({ queryKey: keys.projects.pullRequests(slug), queryFn: () => api.projects.pullRequests(slug) })

export const createProject = defineMutation<Project, CreateProjectInput>({
  mutationFn: input => api.projects.create(input),
  invalidates: [keys.projects.list()]
})
export const patchProject = defineMutation<Project, { slug: string, input: PatchProjectInput }>({
  mutationFn: ({ slug, input }) => api.projects.patch(slug, input),
  invalidates: (_, { slug }) => [keys.projects.list(), keys.projects.detail(slug)]
})
