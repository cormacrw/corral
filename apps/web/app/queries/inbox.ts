import { matchMutation, queryOptions, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { Inbox, InboxActionInput, Task } from '@corral/contracts'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { api } from '~/composables/useApi'
import { defineMutation, inboxWithRead, invalidateKeys, writeTaskResponse } from './dependencies'
import { keys } from './keys'

// Reads land in the cache as they happen, and a response can predate them
const unreadIds = (inbox: Inbox | undefined) => [...inbox?.needsYou ?? [], ...inbox?.activity ?? []].filter(i => 'unread' in i && i.unread).map(i => i.id)

export const inboxQuery = () => queryOptions({
  queryKey: keys.inbox(),
  queryFn: async ({ client }) => {
    const before = client.getQueryData<Inbox>(keys.inbox())
    const loaded = await api.inbox.get()
    const still = new Set(unreadIds(client.getQueryData<Inbox>(keys.inbox())))
    return unreadIds(before).filter(id => !still.has(id)).reduce(inboxWithRead, loaded)
  }
})

export const actOnInboxItem = defineMutation<{ task: Task | null }, { taskId: string, input: InboxActionInput }>({
  mutationFn: ({ taskId, input }) => api.inbox.act(taskId, input),
  write: (client, { task }) => {
    if (task) writeTaskResponse(client, task)
  },
  // Awaited: the page moves on with the fresh list (moveToNext)
  invalidates: [keys.inbox()],
  refreshes: ({ task }) => task ? [] : [keys.tasks.lists()]
})

// Clears the dot before the request. A failure refetches the true state.
export const readDeployment = {
  ...defineMutation<unknown, string>({ mutationFn: id => api.deployments.read(id), invalidates: [] }),
  onMutate: (id: string, { client }: { client: ReturnType<typeof useQueryClient> }) => {
    client.setQueryData<Inbox>(keys.inbox(), inbox => inbox && inboxWithRead(inbox, id))
  },
  onError: (_error: Error, _id: string, _context: unknown, { client }: { client: ReturnType<typeof useQueryClient> }) => invalidateKeys(client, [keys.inbox()])
}

export const dismissDeployment = defineMutation<unknown, string>({
  mutationFn: id => api.deployments.dismiss(id),
  invalidates: [keys.inbox()]
})

// Spread into a useMutation for an action that resolves the selected item
export const holdsInbox = { mutationKey: keys.inboxResolving() }

// The Inbox as the page shows it. While a holdsInbox mutation runs, the list
// stays as it was when it started: live events can remove the item or reorder
// its neighbours, and the selection would jump before the action finishes. A
// failure lets go; on success the page moves on with the fresh `data`, then
// calls `release`.
export function useHeldInbox() {
  const client = useQueryClient()
  const query = useQuery(inboxQuery())
  const held = shallowRef<Inbox | null>(null)
  let holder: number | null = null
  const release = () => {
    holder = null
    held.value = null
  }
  onScopeDispose(client.getMutationCache().subscribe((event) => {
    if (event.type !== 'updated' || !matchMutation(holdsInbox, event.mutation)) return
    if (event.action.type === 'pending') {
      holder = event.mutation.mutationId
      held.value = client.getQueryData<Inbox>(keys.inbox()) ?? null
    } else if (event.action.type === 'error' && event.mutation.mutationId === holder) release()
  }))
  return { ...query, inbox: computed(() => held.value ?? query.data.value ?? null), release }
}
