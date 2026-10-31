import { useQuery } from '@tanstack/vue-query'
import { planSessionsQuery } from '~/queries/plan'
import type { Ref } from 'vue'
import type { PlanSession } from '@corral/contracts'

// The Plan sessions open as threads (design/plan.md), in their order. Kept in
// localStorage and shared by both Plan pages, so it lives in a detached
// scope rather than whichever page asked first.
let open: Ref<string[]> | null = null

export function usePlanThreads() {
  open ??= effectScope(true).run(() => useLocalStorage<string[]>('corral.plan.tabs', []))!
  const threads = open

  function add(id: string): void {
    if (!threads.value.includes(id)) threads.value = [...threads.value, id]
  }
  function remove(id: string): void {
    threads.value = threads.value.filter(x => x !== id)
  }
  // Sessions that no longer exist lose their thread
  function prune(existing: string[]): void {
    const keep = new Set(existing)
    if (threads.value.some(id => !keep.has(id))) threads.value = threads.value.filter(id => keep.has(id))
  }

  return { threads, add, remove, prune }
}

// The open sessions in the side nav and mobile switcher.
// Status comes from the sessions query, which plan.session events keep
// current. Call it from a component: it tracks the current session as a thread.
export function useOpenPlanSessions() {
  const query = useQuery(planSessionsQuery())
  const planSessions = computed(() => query.data.value ?? [])
  const pending = usePendingPlan()
  const route = useRoute()
  const { threads, add, remove, prune } = usePlanThreads()

  const active = computed(() => typeof route.params.sessionId === 'string' ? route.params.sessionId : null)
  watch(active, (id) => {
    if (id) add(id)
  }, { immediate: true })
  // Only against a full load: a session you just started may not have arrived yet
  watch(() => query.isSuccess.value, (loaded) => {
    if (loaded) prune([...planSessions.value.filter(s => !s.closed || s.id === active.value).map(s => s.id), ...Object.keys(pending.entries.value)])
  }, { immediate: true })

  const sessions = computed(() => {
    const byId = new Map(planSessions.value.map(s => [s.id, s]))
    for (const entry of Object.values(pending.entries.value)) if (!byId.has(entry.session.id)) byId.set(entry.session.id, entry.session)
    return threads.value.map(id => byId.get(id)).filter((s): s is PlanSession => s !== undefined)
  })

  function close(session: PlanSession) {
    remove(session.id)
  }

  // Compare snapshots so read acknowledgements for a reopened, still-closed
  // session don't remove it again. Only the transition to closed removes it.
  watch(() => planSessions.value, (next, previous) => {
    const before = new Map(previous.map(s => [s.id, s]))
    for (const session of next) {
      const old = before.get(session.id)
      if (!old) continue
      if (session.closed && !old.closed) remove(session.id)
      else if (!session.closed && old.closed && session.id === active.value) add(session.id)
    }
  }, { flush: 'sync' })

  return { active, sessions, close }
}
