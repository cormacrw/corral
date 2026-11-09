import { errorText } from '@corral/core'
import { ref, watch, type ComputedRef } from 'vue'
import { useMutation } from '@tanstack/vue-query'
import type { PatchTaskInput, Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'
import { moveTask, patchTask, removeTask, resumeTask, type TaskAddress } from '~/queries/tasks'
import { useSavedNote } from '~/composables/useSavedNote'
import { refusedNotReady } from '~/queries/client'
import { boardMove } from '~/features/board/utils/board'

interface TaskTarget {
  task: ComputedRef<Task | null>
  address: ComputedRef<TaskAddress>
}

// What a person does to the open task. A request can outlive the task it was
// for, so each one checks it's still open before touching state on screen.
export function useTaskActions({ task, address }: TaskTarget, onRemoved: () => void) {
  const toast = useToast()
  const patchMutation = useMutation(patchTask)
  const transitionMutation = useMutation(moveTask)
  const removeMutation = useMutation(removeTask)
  const resumeMutation = useMutation(resumeTask)
  const { saved, flash: flashSaved, clear: clearSaved } = useSavedNote()
  const resuming = ref(false)
  const placing = ref(false)
  const confirmDelete = ref(false)
  const isOpen = (requested: string) => requested === address.value.ref

  watch(() => address.value.ref, () => {
    confirmDelete.value = false
    clearSaved()
    resuming.value = false
    placing.value = false
  })

  function fail(e: unknown) {
    toast.add({ title: 'Not saved', description: errorText(e), color: 'error' })
  }
  function failMove(e: unknown) {
    if (refusedNotReady(e)) toast.add({ title: 'Not ready yet', description: e.message, color: 'warning' })
    else fail(e)
  }
  // Confirms an action on this task, unless another task replaced it while the
  // request ran
  async function confirm(request: Promise<Task>) {
    const requested = address.value.ref
    await request
    if (isOpen(requested)) flashSaved()
  }

  // Resolves false when not saved, so an edit in progress stays open
  async function patch(input: PatchTaskInput): Promise<boolean> {
    if (!task.value) return false
    try {
      await confirm(patchMutation.mutateAsync({ task: address.value, input }))
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }

  // value is a Status menu option: 'current' or the status to move to
  async function changeStatus(value: string) {
    const status = value as TaskStatus
    const input = task.value && value !== 'current' ? boardMove(task.value, status) : null
    if (!input) return
    try {
      await confirm(transitionMutation.mutateAsync({ task: address.value, input, status }))
    } catch (e) {
      failMove(e)
    }
  }

  async function resume() {
    if (!task.value) return
    const requested = address.value.ref
    resuming.value = true
    try {
      await confirm(resumeMutation.mutateAsync({ task: address.value }))
    } catch (e) {
      fail(e)
    } finally {
      if (isOpen(requested)) resuming.value = false
    }
  }

  async function place() {
    if (!task.value) return
    const requested = address.value.ref
    placing.value = true
    try {
      const added = await transitionMutation.mutateAsync({ task: address.value, input: { type: 'approve' }, status: 'ready' })
      toast.add({ title: `${added.ref} added to the board`, color: 'success' })
    } catch (e) {
      failMove(e)
    } finally {
      if (isOpen(requested)) placing.value = false
    }
  }

  async function remove() {
    if (!task.value || removeMutation.isPending.value) return
    const requested = address.value.ref
    try {
      await removeMutation.mutateAsync({ task: address.value })
      toast.add({ title: `${requested} deleted`, color: 'neutral' })
      if (!isOpen(requested)) return
      confirmDelete.value = false
      onRemoved()
    } catch (e) {
      fail(e)
    }
  }

  return { saved, resuming, placing, confirmDelete, removing: removeMutation.isPending, fail, patch, changeStatus, resume, place, remove }
}
