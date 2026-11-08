import { getCurrentScope, onScopeDispose, ref } from 'vue'

const SAVED_MS = 1800

// The "Saved" note after an edit, which clears itself after a moment
export function useSavedNote() {
  const saved = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear() {
    if (timer) clearTimeout(timer)
    timer = null
    saved.value = false
  }
  function flash() {
    clear()
    saved.value = true
    timer = setTimeout(() => {
      timer = null
      saved.value = false
    }, SAVED_MS)
  }
  if (getCurrentScope()) onScopeDispose(clear)

  return { saved, flash, clear }
}
