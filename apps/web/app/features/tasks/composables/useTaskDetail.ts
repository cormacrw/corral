import { computed } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { seededTaskQuery, taskCommentsQuery, taskEvidenceQuery, taskHistoryQuery, taskReviewsQuery, type TaskAddress } from '~/queries/tasks'
import { runsQuery } from '~/queries/runs'

// Everything the task detail shows, loaded for the task open now
export function useTaskDetail(taskRef: () => string) {
  const shell = useShell()
  const client = useQueryClient()
  const taskResult = useQuery(computed(() => seededTaskQuery(client, taskRef())))
  const task = computed(() => taskResult.data.value ?? null)
  const project = computed(() => shell.projects.find(p => p.id === task.value?.projectId) ?? null)
  const slug = computed(() => project.value?.slug ?? '')
  const { tasks: listed, epics } = useProjectLists(slug)
  const projectTasks = computed(() => project.value ? listed.value : [])
  const address = computed((): TaskAddress => ({ slug: slug.value, number: task.value?.number ?? 0, ref: taskRef() }))
  const taskEpic = computed(() => epics.value.find(e => e.id === task.value?.epicId) ?? null)
  // A task in a collapsed one-task epic is top-level, so it shows no parent
  const epic = computed(() => task.value?.parentTask ? taskEpic.value : null)
  const delivery = computed(() => task.value?.parentTask ? null : taskEpic.value)

  // Each part of the task is its own query, so an event refetches only its part
  function side<T>(query: (task: TaskAddress) => T) {
    return computed(() => ({ ...query(address.value), enabled: Boolean(task.value && project.value) }))
  }
  const commentsResult = useQuery(side(taskCommentsQuery))
  const historyResult = useQuery(side(taskHistoryQuery))
  const evidenceResult = useQuery(side(taskEvidenceQuery))
  const reviewsResult = useQuery(side(taskReviewsQuery))
  // The task's runs, so activity names the agent that acted
  const runsResult = useQuery(computed(() => ({ ...runsQuery({ taskId: task.value?.id }), enabled: Boolean(task.value) })))
  const results = [taskResult, commentsResult, historyResult, evidenceResult, reviewsResult, runsResult]
  // A failed background refetch leaves what's cached on screen
  const error = computed(() => results.find(r => r.isLoadingError.value)?.error.value?.message ?? null)
  const retry = () => Promise.all(results.filter(r => r.isLoadingError.value).map(r => r.refetch()))

  return {
    task,
    project,
    slug,
    address,
    epic,
    delivery,
    projectTasks,
    pending: taskResult.isPending,
    error,
    retry,
    comments: computed(() => commentsResult.data.value ?? []),
    history: computed(() => historyResult.data.value ?? []),
    evidence: computed(() => evidenceResult.data.value ?? []),
    reviews: computed(() => reviewsResult.data.value ?? []),
    runs: computed(() => runsResult.data.value ?? [])
  }
}
