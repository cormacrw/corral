import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue'

// One clock for relative times, ticking every 30 seconds while anything reads
// it. Read it in a small leaf (TimeAgo, ElapsedTime), not a page: every reader
// re-renders on each tick. Agent pages tick by the second with their own clock.
export const NOW_TICK_MS = 30_000
const now = ref(Date.now())
let readers = 0
let timer: ReturnType<typeof setInterval> | undefined

export function useNow() {
  if (readers++ === 0) {
    now.value = Date.now()
    timer = setInterval(() => {
      now.value = Date.now()
    }, NOW_TICK_MS)
  }
  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (--readers === 0) clearInterval(timer)
    })
  }
  return readonly(now)
}
