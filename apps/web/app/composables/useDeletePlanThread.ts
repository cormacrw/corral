import type { PlanThreadItem } from '@corral/contracts'
import { api } from '~/composables/useApi'

export const UNDO_MS = 5000

// Deleting a Plan thread from the Inbox (design/inbox.md#mobile): the row goes
// at once and a toast offers Undo for five seconds. Only then is the session
// closed, discarding its drafts, so Undo has nothing to restore on the server.
// Module state, so a delete started on the thread screen outlives it.
const pending = ref<string[]>([])
const timers = new Map<string, ReturnType<typeof setTimeout>>()
// The Inbox list registers its reload, so the closed thread is gone from the
// loaded list before it stops being hidden
let reload: (() => Promise<unknown>) | null = null

export function useDeletePlanThread(refresh?: () => Promise<unknown>) {
  const toast = useToast()
  const threads = usePlanThreads()
  if (refresh) reload = refresh

  const hidden = (sessionId: string) => pending.value.includes(sessionId)
  const unhide = (sessionId: string) => {
    pending.value = pending.value.filter(id => id !== sessionId)
  }

  async function commit(item: PlanThreadItem) {
    timers.delete(item.sessionId)
    try {
      await api.plan.close(item.sessionId)
      threads.remove(item.sessionId)
      await reload?.().catch(() => {})
    } catch (e) {
      toast.add({ title: 'Couldn\'t delete the thread', description: e instanceof Error ? e.message : String(e), color: 'error' })
    } finally {
      unhide(item.sessionId)
    }
  }

  function remove(item: PlanThreadItem) {
    if (hidden(item.sessionId)) return
    pending.value = [...pending.value, item.sessionId]
    const id = `delete-thread-${item.sessionId}`
    timers.set(item.sessionId, setTimeout(() => void commit(item), UNDO_MS))
    toast.add({
      id,
      title: 'Thread deleted',
      description: item.subject,
      icon: 'i-lucide-trash-2',
      duration: UNDO_MS,
      actions: [{
        label: 'Undo',
        color: 'neutral',
        variant: 'outline',
        onClick: () => {
          clearTimeout(timers.get(item.sessionId))
          timers.delete(item.sessionId)
          unhide(item.sessionId)
          toast.remove(id)
        }
      }]
    })
  }

  return { remove, hidden }
}
