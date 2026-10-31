import { useQuery } from '@tanstack/vue-query'
import { computed, inject, provide, toValue, type ComputedRef, type InjectionKey, type MaybeRefOrGetter } from 'vue'
import { DEFAULT_FLOW_WINDOW, flowQuery, projectsQuery, pullRequestsQuery } from '~/queries/projects'

// The project behind every /projects/:slug route. pages/projects/[slug].vue
// holds it, so moving between tabs keeps its observers: a new observer on
// entries older than staleTime would refetch them, and events already keep
// them current. Another project gets a new parent, so nothing carries over.
function projectList() {
  // The shell keeps the list current, so mounting here never asks again
  return useQuery({ ...projectsQuery(), refetchOnMount: false })
}

// Until the list loads, nothing counts as missing. The project being removed
// here is about to be left, not missing.
export function useProjectMissing(slug: MaybeRefOrGetter<string | null>): ComputedRef<boolean> {
  const { data: projects } = projectList()
  const removing = useRemovingProject()
  return computed(() => {
    const current = toValue(slug)
    return current !== null && removing.value !== current && (projects.value?.every(p => p.slug !== current) ?? false)
  })
}

export function provideProject(slug: ComputedRef<string>, overviewOpen: () => boolean) {
  const { data: projects } = projectList()
  const project = computed(() => projects.value?.find(p => p.slug === slug.value) ?? null)
  const known = computed(() => project.value?.slug ?? '')
  const lists = useProjectLists(known)
  // Polls while any tab of the project is open, so Pull requests opens current
  const pullRequests = useQuery(computed(() => ({ ...pullRequestsQuery(slug.value), enabled: Boolean(known.value) })))
  useQuery(computed(() => ({ ...flowQuery(slug.value, DEFAULT_FLOW_WINDOW), enabled: Boolean(known.value) })))
  const overview = useProjectOverview({ slug, project, ...lists, open: overviewOpen })
  const context = { slug, projects, project, ...lists, pullRequests, overview }
  provide(PROJECT, context)
  return context
}

const PROJECT: InjectionKey<ReturnType<typeof provideProject>> = Symbol('project')

export const useProject = () => inject(PROJECT)!
