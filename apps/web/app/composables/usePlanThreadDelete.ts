// Delete thread (design/inbox.md#delete-thread): the row goes at once and the
// close waits out a 5 second Undo toast. The state lives
// outside any page, so leaving the Inbox doesn't cancel a delete, and one
// still pending when the tab closes or reloads is sent as it unloads.
import { useMutation } from '@tanstack/vue-query'
import { closePlanThread, closePlanThreadOnExit } from '~/queries/plan'
import { readonly, ref } from 'vue'

export const UNDO_MS = 5000

const pending = ref<string[]>([])
const timers = new Map<string, { timer: ReturnType<typeof setTimeout>, toastId: string | number }>()
let listening = false

function forget(id: string) {
  timers.delete(id)
  pending.value = pending.value.filter(x => x !== id)
}

export function usePlanThreadDelete() {
  const toast = useToast()
  const closing = useMutation(closePlanThread)
  const threads = usePlanThreads()

  if (!listening && typeof window !== 'undefined') {
    listening = true
    window.addEventListener('pagehide', () => {
      for (const [id, { timer }] of timers) {
        clearTimeout(timer)
        timers.delete(id)
        threads.remove(id)
        void closePlanThreadOnExit(id).catch(() => {})
      }
    })
  }

  function remove(sessionId: string) {
    if (timers.has(sessionId)) return
    pending.value = [...pending.value, sessionId]
    const shown = toast.add({
      title: 'Thread deleted · its drafts were discarded',
      icon: 'i-lucide-trash-2',
      duration: UNDO_MS,
      actions: [{ label: 'Undo', icon: 'i-lucide-undo-2', onClick: () => undo(sessionId) }]
    })
    const timer = setTimeout(() => void commit(sessionId), UNDO_MS)
    timers.set(sessionId, { timer, toastId: shown.id })

    async function commit(id: string) {
      timers.delete(id)
      try {
        // Settles once the list has refetched, so the row can't reappear in between
        await closing.mutateAsync(id)
        threads.remove(id)
      } catch (e) {
        toast.add({ title: 'Could not delete the thread', description: e instanceof Error ? e.message : String(e), color: 'error' })
      } finally {
        pending.value = pending.value.filter(x => x !== id)
      }
    }
  }

  function undo(sessionId: string) {
    const entry = timers.get(sessionId)
    if (!entry) return
    clearTimeout(entry.timer)
    toast.remove(entry.toastId)
    forget(sessionId)
  }

  return { pending: readonly(pending), remove, undo }
}
