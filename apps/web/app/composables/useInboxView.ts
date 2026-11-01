// What the Inbox's list and its selected item share (design/inbox.md):
// pages/inbox.vue provides it, so it lasts across selections, and
// pages/inbox/[itemId].vue, which remounts per item, reads it.
import { useQueryClient } from '@tanstack/vue-query'
import type { InboxItem, PlanThreadItem, TaskInboxItem } from '@corral/contracts'
import { inject, provide, type InjectionKey } from 'vue'
import { useHeldInbox } from '~/queries/inbox'
import { taskQuery } from '~/queries/tasks'

export const isOwnPane = (item: InboxItem | null) => item?.type === 'plan_thread' || item?.type === 'epic_review' || item?.type === 'release_notes' || item?.type === 'epic_conflict' || item?.type === 'epic_activity'
export const isTaskItem = (item: InboxItem | null): item is TaskInboxItem => item?.taskId != null

const PREFETCH_LIMIT_MS = 1000

function createInboxView() {
  const route = useRoute()
  const router = useRouter()
  const flyout = useTaskFlyout()
  const device = useDevice()
  const deletes = usePlanThreadDelete()
  const client = useQueryClient()
  const list = useHeldInbox()
  const inbox = list.inbox
  // A failed refetch keeps the list it has
  const error = computed(() => inbox.value ? null : list.error.value?.message ?? null)
  const tab = ref<'needsYou' | 'activity' | 'resolved'>('needsYou')
  const search = ref('')

  const isHidden = (item: InboxItem) => deletes.pending.value.includes(item.id)
  // In the server's order (newest first, D11), less threads waiting out their Undo
  const items = computed<InboxItem[]>(() => (inbox.value?.[tab.value] ?? []).filter(i => !isHidden(i)).filter(i => !search.value || `${i.taskRef ?? ''} ${i.subject} ${i.preview}`.toLowerCase().includes(search.value.toLowerCase())))
  const count = computed(() => (inbox.value?.count ?? 0) - (inbox.value?.needsYou.filter(isHidden).length ?? 0))
  const selectedId = computed(() => typeof route.params.itemId === 'string' ? route.params.itemId : null)
  // Leaving during an action hands the list to the new selection
  watch(selectedId, list.release)
  // A thread leaves Needs you once it's answered or replied to (D11), while
  // the PM's turn is still running. Keep its conversation open so the turn
  // streams in, until another item is picked.
  const openThread = shallowRef<PlanThreadItem | null>(null)
  watch(() => inbox.value?.needsYou.find(i => i.id === selectedId.value), (item) => {
    if (item?.type === 'plan_thread') openThread.value = item
  }, { immediate: true })
  const selected = computed<InboxItem | null>(() => {
    if (!inbox.value || !selectedId.value) return null
    return [...inbox.value.needsYou, ...inbox.value.activity, ...inbox.value.resolved].find(i => i.id === selectedId.value)
      ?? (openThread.value?.id === selectedId.value ? { ...openThread.value, unread: false } : null)
  })

  watch(() => selected.value?.id, async (_, previous) => {
    const item = selected.value
    // A selection with nothing to show (e.g. the last item was just resolved).
    // Plain /inbox?task= has no selection to lose: its dock is a shared link.
    if (!item) {
      if (selectedId.value || previous) void flyout.close()
    } else if (isOwnPane(item)) {
      if (flyout.ref.value || flyout.epic.value) await flyout.close()
    }
  }, { immediate: true })
  function toggleTask() {
    if (flyout.ref.value) flyout.close()
    else if (selected.value?.taskRef) flyout.open(selected.value.taskRef, { replace: true })
  }

  // An item opens with the task flyout closed, whatever the last one had open.
  function itemRoute(item: InboxItem | undefined) {
    return { path: item ? `/inbox/${item.id}` : '/inbox', query: {} }
  }
  // Resolving moves to the item at the same position, or to the empty state when
  // that was the last one. The held list still has the old position.
  async function moveToNext() {
    const position = items.value.findIndex(i => i.id === selectedId.value)
    const remaining = (list.data.value?.needsYou ?? []).filter(i => !isHidden(i))
    const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)]
    // Arrive with its task, so the panes never show a skeleton, but don't let a
    // slow or failing task hold up the move
    const leaving = selectedId.value
    if (next?.taskRef) await Promise.race([client.prefetchQuery(taskQuery(next.taskRef)), new Promise(resolve => setTimeout(resolve, PREFETCH_LIMIT_MS))])
    // Picked another item or left meanwhile: that selection stands
    if (selectedId.value !== leaving) return
    await router.replace(itemRoute(next))
    list.release()
  }
  // Delete thread, from its row or its header: no confirmation, Undo instead.
  // Deleting the selected thread moves on to the next item, as resolving does.
  async function deleteThread(item: PlanThreadItem) {
    const position = items.value.findIndex(i => i.id === item.id)
    deletes.remove(item.sessionId)
    if (selectedId.value !== item.id) return
    if (openThread.value?.id === item.id) openThread.value = null
    await flyout.close()
    const remaining = items.value
    const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)]
    await router.replace(itemRoute(next))
  }

  // On a phone the shell's header names the item and where it sits in the list.
  // Set here because the next item mounts before the last one unmounts.
  const mobileHeader = useMobileHeader()
  watchEffect(() => {
    if (!device.isMobile.value || !selectedId.value) {
      mobileHeader.value = null
      return
    }
    const position = inbox.value?.needsYou.findIndex(i => i.id === selectedId.value) ?? -1
    mobileHeader.value = {
      title: isOwnPane(selected.value) ? selected.value!.subject : selected.value?.taskRef ?? '',
      eyebrow: position >= 0 ? `Inbox · ${position + 1} of ${inbox.value!.needsYou.length}` : 'Inbox'
    }
  })
  onBeforeUnmount(() => {
    mobileHeader.value = null
  })

  return { list, inbox, error, tab, search, items, count, selectedId, selected, toggleTask, itemRoute, moveToNext, deleteThread }
}

const INBOX_VIEW: InjectionKey<ReturnType<typeof createInboxView>> = Symbol('inbox-view')

export function provideInboxView() {
  const view = createInboxView()
  provide(INBOX_VIEW, view)
  return view
}

export function useInboxView() {
  const view = inject(INBOX_VIEW)
  if (!view) throw new Error('useInboxView needs pages/inbox.vue above it')
  return view
}
