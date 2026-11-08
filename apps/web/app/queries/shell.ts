import type { QueryClient } from '@tanstack/vue-query'
import { useQuery } from '@tanstack/vue-query'
import { computed, effectScope, reactive, shallowRef } from 'vue'
import { agentsQuery } from './agents'
import { inboxQuery } from './inbox'
import { planSessionsQuery } from './plan'
import { projectsQuery } from './projects'
import { profileQuery, runnerQuery, statusQuery } from './system'

// The data the shell shows on every page. One observer per query for the life
// of the app, so these stay current from events and navigation never refetches
// them, however many components read them.
function createShell(client: QueryClient) {
  const projects = useQuery(projectsQuery(), client)
  const agents = useQuery(agentsQuery(), client)
  const runner = useQuery(runnerQuery(), client)
  const status = useQuery(statusQuery(), client)
  const profile = useQuery(profileQuery(), client)
  const planSessions = useQuery(planSessionsQuery(), client)
  const inboxCount = useQuery({ ...inboxQuery(), select: inbox => inbox.count }, client)
  const queries = [projects, agents, runner, status, profile, planSessions, inboxCount]
  return {
    projects, agents, runner, status, profile, planSessions, inboxCount,
    // Stays true through a failed background refetch, which keeps its data
    loaded: computed(() => queries.every(query => query.data.value !== undefined)),
    error: computed(() => queries.find(query => query.error.value)?.error.value?.message ?? null),
    reload: () => Promise.all(queries.map(query => query.refetch()))
  }
}

const current = shallowRef<ReturnType<typeof createShell> | null>(null)

// What every page shows, by name: read-only and empty until the shell
// starts. Change this data with a mutation.
export function useShell() {
  return reactive({
    loaded: computed(() => current.value?.loaded.value ?? false),
    error: computed(() => current.value?.error.value ?? null),
    projects: computed(() => current.value?.projects.data.value ?? []),
    agents: computed(() => current.value?.agents.data.value ?? []),
    profile: computed(() => current.value?.profile.data.value ?? null),
    runner: computed(() => current.value?.runner.data.value ?? null),
    status: computed(() => current.value?.status.data.value ?? { stopped: false, updating: false }),
    inboxCount: computed(() => current.value?.inboxCount.data.value ?? 0),
    planSessions: computed(() => current.value?.planSessions.data.value ?? [])
  })
}

// Called once the first navigation is through: the setup middleware has its own
// cold-start request, which mustn't wait out these queries' retries. Returns a stop.
export function startShell(client: QueryClient): () => void {
  const scope = effectScope(true)
  current.value = scope.run(() => createShell(client))!
  return () => {
    scope.stop()
    current.value = null
  }
}

// For the human asking to check again, as Retry and Reconnect do
export async function reloadShell(): Promise<void> {
  await current.value?.reload()
}
