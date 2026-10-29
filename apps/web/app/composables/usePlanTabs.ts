import type { Ref } from 'vue'

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
