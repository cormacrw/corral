import { queryOptions } from '@tanstack/vue-query'
import type { Comment, CreateTaskInput, HumanTransitionInput, PatchTaskInput, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import { keys } from './keys'

// The API addresses a task by project and number; the cache by ref
export type TaskAddress = Pick<Task, 'ref' | 'number'> & { slug: string }

export const tasksQuery = (slug: string) => queryOptions({ queryKey: keys.tasks.list(slug), queryFn: () => api.tasks.list(slug, 'all') })
export const taskQuery = (ref: string) => queryOptions({ queryKey: keys.tasks.detail(ref), queryFn: () => api.tasks.byRef(ref) })
export const taskCommentsQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.comments(ref), queryFn: () => api.tasks.comments(slug, number) })
export const taskHistoryQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.history(ref), queryFn: () => api.tasks.history(slug, number) })
export const taskEvidenceQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.evidence(ref), queryFn: () => api.tasks.evidence(slug, number) })
export const taskReviewsQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.reviews(ref), queryFn: () => api.tasks.reviews(slug, number) })
export const taskDesignsQuery = ({ slug, number, ref }: TaskAddress) => queryOptions({ queryKey: keys.tasks.designs(ref), queryFn: () => api.tasks.designs(slug, number) })

const changed = (slug: string, ref: string) => [keys.tasks.list(slug), keys.tasks.detail(ref), keys.inbox()]

export const createTask = defineMutation<Task, { slug: string, input: CreateTaskInput }>({
  mutationFn: ({ slug, input }) => api.tasks.create(slug, input),
  invalidates: (_, { slug }) => [keys.tasks.list(slug), keys.inbox()]
})
export const patchTask = defineMutation<Task, { task: TaskAddress, input: PatchTaskInput }>({
  mutationFn: ({ task, input }) => api.tasks.patch(task.slug, task.number, input),
  invalidates: (_, { task }) => changed(task.slug, task.ref)
})
export const transitionTask = defineMutation<Task, { task: TaskAddress, input: HumanTransitionInput }>({
  mutationFn: ({ task, input }) => api.tasks.transition(task.slug, task.number, input),
  invalidates: (_, { task }) => changed(task.slug, task.ref)
})
export const commentOnTask = defineMutation<Comment, { task: TaskAddress, body: string, pinned?: boolean }>({
  mutationFn: ({ task, body, pinned }) => api.tasks.comment(task.slug, task.number, body, pinned),
  invalidates: (_, { task }) => [keys.tasks.comments(task.ref), keys.tasks.history(task.ref)]
})
