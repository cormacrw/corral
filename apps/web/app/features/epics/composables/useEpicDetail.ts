import { taskNumber, epicWithLiveCounts } from '~/utils/labels'
import { useMutation, useQuery } from '@tanstack/vue-query'
import type { PatchEpicInput } from '@corral/contracts'
import { useSavedNote } from '~/composables/useSavedNote'
import { errorMessage } from '~/lib/errors'
import { epicActivityQuery, epicQuery, patchEpic } from '~/queries/epics'
import { taskHistoryQuery } from '~/queries/tasks'

// An epic and what its screen needs around it: its project and parent task, the
// epics it relates to, the activity feed, and saving an edit.
export function useEpicDetail(epicId: () => string) {
  const shell = useShell()
  const toast = useToast()
  const patchMutation = useMutation(patchEpic)
  const epicResult = useQuery(computed(() => epicQuery(epicId())))
  const activityResult = useQuery(computed(() => epicActivityQuery(epicId())))
  const epic = computed(() => epicResult.data.value ?? null)
  // A failed background refetch leaves what's cached on screen
  const error = computed(() => epicResult.isLoadingError.value ? epicResult.error.value?.message ?? null : null)
  const project = computed(() => shell.projects.find(p => p.id === epic.value?.projectId) ?? null)
  const parent = computed(() => {
    const ref = epic.value?.taskRef
    return ref && project.value ? { slug: project.value.slug, number: taskNumber(ref), ref } : null
  })

  // The delivery record's history with the parent task's own
  const parentHistory = useQuery(computed(() => ({
    ...taskHistoryQuery(parent.value ?? { slug: '', number: Number.NaN, ref: '' }),
    enabled: parent.value !== null
  })))
  const activity = computed(() => [...activityResult.data.value ?? [], ...parentHistory.data.value ?? []].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))

  const { tasks: projectTasks, epics: epicList } = useProjectLists(() => project.value?.slug ?? '')
  // Task events update the shared task list, not the epic's aggregate counts.
  const related = computed(() => epicList.value.map(e => epicWithLiveCounts(e, projectTasks.value)))
  const prerequisites = computed(() => related.value.filter(e => epic.value?.dependsOn.includes(e.id)))
  const blockedEpics = computed(() => related.value.filter(e => epic.value?.blocks.includes(e.id)))
  const waiting = computed(() => prerequisites.value.filter(e => e.mergedCount < e.taskCount))
  const choices = computed(() => related.value.filter(e => e.id !== epic.value?.id && !epic.value?.dependsOn.includes(e.id)).map(e => ({ label: e.title, value: e.id })))

  const { saved, flash: flashSaved } = useSavedNote()
  // Resolves false when not saved, so an edit in progress stays open
  async function patch(input: PatchEpicInput): Promise<boolean> {
    if (!epic.value) return false
    try {
      await patchMutation.mutateAsync({ id: epic.value.id, input })
      flashSaved()
      return true
    } catch (e) {
      toast.add({ title: 'Not saved', description: errorMessage(e), color: 'error' })
      return false
    }
  }

  return { epicResult, activityResult, epic, error, project, parent, activity, prerequisites, blockedEpics, waiting, choices, saved, patch }
}
