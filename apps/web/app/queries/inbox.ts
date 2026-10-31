import { queryOptions } from '@tanstack/vue-query'
import type { InboxActionInput, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import { keys } from './keys'

export const inboxQuery = () => queryOptions({ queryKey: keys.inbox(), queryFn: () => api.inbox.get() })

export const actOnInboxItem = defineMutation<{ task: Task | null }, { taskId: string, input: InboxActionInput }>({
  mutationFn: ({ taskId, input }) => api.inbox.act(taskId, input),
  write: (client, { task }) => {
    if (task) client.setQueryData(keys.tasks.detail(task.ref), task)
  },
  invalidates: ({ task }) => [keys.inbox(), keys.tasks.lists(), ...(task ? [keys.tasks.detail(task.ref)] : [])]
})
