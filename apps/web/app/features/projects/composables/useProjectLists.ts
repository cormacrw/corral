import { useQueries, useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { Epic, Project, Task } from '@corral/contracts'
import { tasksQuery } from '~/queries/tasks'
import { epicsQuery } from '~/queries/epics'

// Pages and the shell observe the same per-project entries. Cached data stays
// visible during refetches and events write into these entries immediately.
export function useProjectLists(slug: MaybeRefOrGetter<string>) {
  const tasks = useQuery(computed(() => ({ ...tasksQuery(toValue(slug)), enabled: Boolean(toValue(slug)) })))
  const epics = useQuery(computed(() => ({ ...epicsQuery(toValue(slug)), enabled: Boolean(toValue(slug)) })))
  return {
    // A parent has no work of its own, so the lists of work leave it out (D31)
    tasks: computed(() => (tasks.data.value ?? []).filter(t => t.status !== 'parent')),
    parents: computed(() => (tasks.data.value ?? []).filter(t => t.status === 'parent')),
    epics: computed(() => epics.data.value ?? []),
    loading: computed(() => Boolean(toValue(slug)) && (tasks.isPending.value || epics.isPending.value)),
    // A failed refresh must not replace cached content, including in Overview.
    // Cold-load failures still surface so an unavailable list isn't shown empty.
    error: computed(() => (tasks.isLoadingError.value ? tasks.error.value?.message : null)
      ?? (epics.isLoadingError.value ? epics.error.value?.message : null) ?? null),
    refetch: () => Promise.all([tasks.refetch(), epics.refetch()])
  }
}

// The shell loads every project's lists for counts and command-palette search.
// Build the maps from current projects, so deleted projects disappear at once,
// even while old cache entries are awaiting garbage collection.
export function useAllProjectLists(projects: MaybeRefOrGetter<Project[]>) {
  const tasks = useQueries({ queries: computed(() => toValue(projects).map(p => ({
    ...tasksQuery(p.slug), select: (list: Task[]) => ({ projectId: p.id, list })
  }))), shallow: true })
  const epics = useQueries({ queries: computed(() => toValue(projects).map(p => ({
    ...epicsQuery(p.slug), select: (list: Epic[]) => ({ projectId: p.id, list })
  }))), shallow: true })
  return {
    tasks: computed(() => withoutParents(projectMap(toValue(projects), tasks.value))),
    // Parents too, for finding one by ref or title
    searchable: computed(() => projectMap(toValue(projects), tasks.value)),
    epics: computed(() => projectMap(toValue(projects), epics.value)),
    pending: computed(() => Object.fromEntries(toValue(projects).map((p, i) => [p.id, tasks.value[i]?.isPending ?? true])))
  }
}

function withoutParents(lists: Record<string, Task[] | undefined>): Record<string, Task[] | undefined> {
  return Object.fromEntries(Object.entries(lists).map(([id, list]) => [id, list?.filter(t => t.status !== 'parent')]))
}

// Match by identity rather than array position: projects and query observers
// can update in different ticks when a project is removed or reordered.
function projectMap<T>(projects: Project[], results: { data: { projectId: string, list: T[] } | undefined }[]): Record<string, T[] | undefined> {
  const active = new Set(projects.map(p => p.id))
  return Object.fromEntries(results.flatMap(({ data }) => data && active.has(data.projectId) ? [[data.projectId, data.list]] : []))
}
