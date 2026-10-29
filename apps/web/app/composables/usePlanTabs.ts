import type { Ref } from 'vue'
import type { PlanSession } from '@corral/contracts'

// The Plan sessions open as tabs (design/plan.md), in their order. Kept in
// localStorage and shared by both Plan pages, so it lives in a detached
// scope rather than whichever page asked first.
let open: Ref<string[]> | null = null

export function usePlanTabs() {
  open ??= effectScope(true).run(() => useLocalStorage<string[]>('corral.plan.tabs', []))!
  const tabs = open

  function add(id: string): void {
    if (!tabs.value.includes(id)) tabs.value = [...tabs.value, id]
  }
  function remove(id: string): void {
    tabs.value = tabs.value.filter(x => x !== id)
  }
  // Sessions that no longer exist lose their tab
  function prune(existing: string[]): void {
    const keep = new Set(existing)
    if (tabs.value.some(id => !keep.has(id))) tabs.value = tabs.value.filter(id => keep.has(id))
  }

  return { tabs, add, remove, prune }
}

// The open sessions as the tab strip and the mobile switcher show them.
// Status comes from live.state.planSessions, which plan.session events keep
// current. Call it from a component: it tracks the current session as a tab.
export function useOpenPlanSessions() {
  const live = useLive()
  const route = useRoute()
  const router = useRouter()
  const { tabs, add, remove, prune } = usePlanTabs()

  const active = computed(() => typeof route.params.sessionId === 'string' ? route.params.sessionId : null)
  watch(active, (id) => {
    if (id) add(id)
  }, { immediate: true })
  // Only against a full load: a session you just started may not have arrived yet
  watch(() => live.state.value.loaded, (loaded) => {
    if (loaded) prune(live.state.value.planSessions.map(s => s.id))
  }, { immediate: true })

  const sessions = computed(() => {
    const byId = new Map(live.state.value.planSessions.map(s => [s.id, s]))
    return tabs.value.map(id => byId.get(id)).filter((s): s is PlanSession => s !== undefined)
  })

  // Closing the current tab moves to the one on its right, else its left, else /plan
  async function close(session: PlanSession) {
    const list = sessions.value
    const index = list.findIndex(s => s.id === session.id)
    remove(session.id)
    if (session.id !== active.value) return
    const next = list[index + 1] ?? list[index - 1]
    await router.push(next ? `/plan/${next.id}` : '/plan')
  }

  return { active, sessions, close }
}
