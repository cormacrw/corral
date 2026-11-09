import { matchMutation, queryOptions, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { QueryClient } from '@tanstack/vue-query'
import type { Inbox, InboxActionInput, InboxItem, PlanSession, PlanSessionDetail, Task } from '@corral/contracts'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { api } from './api'
import { defineMutation, inboxWithRead, invalidateKeys, writeQuery, writeTaskResponse } from './dependencies'
import { keys } from './keys'

export const inboxQuery = () => queryOptions({ queryKey: keys.inbox(), queryFn: () => api.inbox.get() })

export const actOnInboxItem = defineMutation<{ task: Task | null }, { taskId: string, input: InboxActionInput }>({
  mutationFn: ({ taskId, input }) => api.inbox.act(taskId, input),
  write: (client, { task }) => {
    if (task) writeTaskResponse(client, task)
  },
  // Awaited: the page moves on with the fresh list (moveToNext)
  invalidates: [keys.inbox()],
  refreshes: ({ task }) => task ? [] : [keys.tasks.lists()]
})

// Plan threads and release notes are read through their session and deployment
type ReadTarget = Pick<InboxItem, 'type' | 'id'>
const sendRead = ({ type, id }: ReadTarget): Promise<unknown> =>
  type === 'plan_thread' ? api.plan.read(id) : type === 'release_notes' ? api.deployments.read(id) : api.inbox.read({ type, id })

// Reading is an acknowledgement, not a content change: the dot clears before
// the request and nothing refetches, so its echo event can't reorder a list.
// A failure refetches the Inbox to bring the dot back. Callers read by item,
// not by its flag, so that can't loop.
export const markRead = {
  mutationFn: sendRead,
  onMutate: ({ type, id }: ReadTarget, { client }: { client: QueryClient }) => {
    if (type === 'plan_thread') {
      writeQuery<PlanSessionDetail>(client, keys.plan.session(id), session => session && { ...session, unread: false })
      writeQuery<PlanSession[]>(client, keys.plan.sessions(), sessions => sessions?.map(session => session.id === id ? { ...session, unread: false } : session))
    }
    writeQuery<Inbox>(client, keys.inbox(), inbox => inbox && inboxWithRead(inbox, id))
  },
  onError: (_error: Error, _target: ReadTarget, _context: unknown, { client }: { client: QueryClient }) => invalidateKeys(client, [keys.inbox()])
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
