// A ref kept in localStorage, for per-user UI preferences only (sidebar
// state, flyout width, drafts). Storage can be unavailable in private
// windows, so every access is guarded.
export function useLocalStorage<T>(key: string, fallback: T): Ref<T> {
  const value = ref(fallback) as Ref<T>
  if (import.meta.client) {
    try {
      const saved = localStorage.getItem(key)
      if (saved !== null) value.value = JSON.parse(saved) as T
    } catch {
      // Keep the fallback
    }
    watch(value, (next) => {
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Nothing to do: the preference just won't persist
      }
    }, { deep: true })
  }
  return value
}
