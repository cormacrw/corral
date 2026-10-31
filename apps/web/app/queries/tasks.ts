import { queryOptions, type QueryClient } from '@tanstack/vue-query'
import type { Comment, CreateTaskInput, HumanTransitionInput, PatchTaskInput, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation, invalidateKeys, withComment, writeTaskResponse } from './dependencies'
import { keys } from './keys'

// The API addresses a task by project and number; the cache by ref
export type TaskAddress = Pick<Task, 'ref' | 'number'> & { slug: string }

export const tasksQuery = (slug: string) => queryOptions({ queryKey: keys.tasks.list(slug), queryFn: async () => (await api.tasks.list(slug, 'all')).filter(task => task.status !== 'draft') })
export const taskQuery = (ref: string) => queryOptions({ queryKey: keys.tasks.detail(ref), queryFn: () => api.tasks.byRef(ref) })
export const taskCommentsQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.comments(ref), queryFn: () => api.tasks.comments(slug, number) })
export const taskHistoryQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.history(ref), queryFn: () => api.tasks.history(slug, number) })
export const taskEvidenceQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.evidence(ref), queryFn: () => api.tasks.evidence(slug, number) })
export const taskReviewsQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.reviews(ref), queryFn: () => api.tasks.reviews(slug, number) })
export const taskDesignsQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.designs(ref), queryFn: () => api.tasks.designs(slug, number) })
// By the item's PR, not the task's: an epic's Activity item links the epic PR.
// A run ending refreshes it, as does a change the human makes to the task.
export const taskPullRequestQuery = ({ slug, ref }: Pick<TaskAddress, 'slug' | 'ref'>, number: number) => queryOptions({ queryKey: keys.tasks.pullRequest(ref, number), queryFn: () => api.projects.pullRequest(slug, number) })

// A list row is the whole task, so opening one shows it while its own copy
// loads, and its side queries needn't wait for that copy. Drafts aren't in
// lists, so they keep the skeleton.
export function listedTask(client: QueryClient, ref: string): Task | undefined {
  for (const [, list] of client.getQueriesData<Task[]>({ queryKey: keys.tasks.lists() })) {
    const task = list?.find(t => t.ref === ref)
    if (task) return task
  }
}
export const seededTaskQuery = (client: QueryClient, ref: string) => ({ ...taskQuery(ref), placeholderData: () => listedTask(client, ref) })

// The response is the task as it now stands and its event brings the rest (its
// history, evidence, epics), so an edit is done when the request is. Whether it
// still needs the human is only known to the server.
const edit = { write: (client: QueryClient, task: Task) => writeTaskResponse(client, task), invalidates: [], refreshes: [keys.inbox()] }
const changed = (slug: string, ref: string) => [keys.tasks.list(slug), keys.tasks.detail(ref), keys.inbox()]

export const createTask = defineMutation<Task, { slug: string, input: CreateTaskInput }>({
  mutationFn: ({ slug, input }) => api.tasks.create(slug, input),
  invalidates: (_, { slug }) => [keys.tasks.list(slug), keys.inbox()]
})
export const patchTask = defineMutation<Task, { task: TaskAddress, input: PatchTaskInput }>({
  mutationFn: ({ task, input }) => api.tasks.patch(task.slug, task.number, input),
  ...edit
})
export const transitionTask = defineMutation<Task, { task: TaskAddress, input: HumanTransitionInput }>({
  mutationFn: ({ task, input }) => api.tasks.transition(task.slug, task.number, input),
  ...edit
})
export const resumeTask = defineMutation<Task, { task: TaskAddress }>({
  mutationFn: ({ task }) => api.tasks.resume(task.slug, task.number),
  ...edit
})
export const approveDesign = defineMutation<Task, { task: TaskAddress, version: number, note?: string }>({
  mutationFn: ({ task, version, note }) => api.tasks.approveDesign(task.slug, task.number, version, note),
  ...edit
})

// Shows at once as a temporary entry, which the response or its event replaces
// and a failure removes
export const commentOnTask = {
  ...defineMutation<Comment, { task: TaskAddress & Pick<Task, 'id'>, body: string }>({
    mutationFn: ({ task, body }) => api.tasks.comment(task.slug, task.number, body),
    write: (client, comment, { task }) => client.setQueryData<Comment[]>(keys.tasks.comments(task.ref), comments => comments && withComment(comments, comment)),
    invalidates: (_, { task }) => [keys.tasks.comments(task.ref)]
  }),
  onMutate: async ({ task, body }: { task: TaskAddress & Pick<Task, 'id'>, body: string }, { client }: { client: QueryClient }) => {
    const key = keys.tasks.comments(task.ref)
    // A fetch already running started before this comment and would drop it
    await client.cancelQueries({ queryKey: key })
    const pending: Comment = { id: `pending-${crypto.randomUUID()}`, taskId: task.id, author: { kind: 'human', userId: 'me' }, body, pinned: false, createdAt: new Date().toISOString() }
    client.setQueryData<Comment[]>(key, comments => comments && [...comments, pending])
    return { pending }
  },
  onError: (_error: Error, { task }: { task: TaskAddress }, context: { pending: Comment } | undefined, { client }: { client: QueryClient }) => {
    client.setQueryData<Comment[]>(keys.tasks.comments(task.ref), comments => comments?.filter(c => c.id !== context?.pending.id))
  }
}

export const removeTask = defineMutation<null, { task: TaskAddress }>({
  mutationFn: ({ task }) => api.tasks.remove(task.slug, task.number),
  invalidates: (_, { task }) => [...changed(task.slug, task.ref), keys.epics.lists()]
})

// Only the moved card is restored on rejection: rolling back a whole list
// would also undo unrelated SSE updates or another card's successful move.
export const moveTask = {
  ...transitionTask,
  onMutate: async ({ task, status }: { task: TaskAddress, input: HumanTransitionInput, status: Task['status'] }, { client }: { client: QueryClient }) => {
    const key = keys.tasks.list(task.slug)
    const interrupted = client.isFetching({ queryKey: key }) > 0
    await client.cancelQueries({ queryKey: key })
    const previous = client.getQueryData<Task[]>(key)?.find(t => t.ref === task.ref)
    // Human moves only land on statuses with no reason or Draft session
    const optimistic = previous && { ...previous, status, statusReason: null, draftSession: null } as Task
    if (optimistic) client.setQueryData<Task[]>(key, list => list?.map(t => t.id === optimistic.id ? optimistic : t))
    return { interrupted, previous, optimistic: client.getQueryData<Task[]>(key)?.find(t => t.ref === task.ref) }
  },
  onError: (_error: Error, { task }: { task: TaskAddress }, context: { previous?: Task, optimistic?: Task } | undefined, { client }: { client: QueryClient }) => {
    if (!context?.previous) return
    const { previous, optimistic } = context
    client.setQueryData<Task[]>(keys.tasks.list(task.slug), list => list?.map(t => t === optimistic ? previous : t))
  },
  // The fetch it stopped may have been bringing something other than this card
  onSettled: (_data: unknown, _error: unknown, { task }: { task: TaskAddress }, context: { interrupted?: boolean } | undefined, { client }: { client: QueryClient }) => {
    if (context?.interrupted) void invalidateKeys(client, [keys.tasks.list(task.slug)])
  }
}
