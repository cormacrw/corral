import type { QueryClient } from '@tanstack/vue-query'
import { useQuery } from '@tanstack/vue-query'
import { computed, effectScope, shallowRef } from 'vue'
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

export const shell = () => current.value

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
