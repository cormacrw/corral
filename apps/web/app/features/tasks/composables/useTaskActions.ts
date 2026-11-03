import { ref, watch, type ComputedRef } from 'vue'
import { useMutation } from '@tanstack/vue-query'
import type { PatchTaskInput, Task } from '@corral/contracts'
import { moveTask, patchTask, removeTask, resumeTask, type TaskAddress } from '~/queries/tasks'
import { ApiError } from '~/queries/client'
import { notReadyNeeds, statusMove } from '~/features/tasks/utils/taskDetail'

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
  const saved = ref(false)
  const resuming = ref(false)
  const placing = ref(false)
  const confirmDelete = ref(false)
  const isOpen = (requested: string) => requested === address.value.ref
  let savedTimer: ReturnType<typeof setTimeout> | null = null

  watch(() => address.value.ref, () => {
    confirmDelete.value = false
    saved.value = false
    resuming.value = false
    placing.value = false
    if (savedTimer) clearTimeout(savedTimer)
  })

  function flashSaved() {
    saved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      saved.value = false
    }, 1800)
  }
  function fail(e: unknown) {
    toast.add({ title: 'Not saved', description: e instanceof ApiError ? e.message : String(e), color: 'error' })
  }
  function failMove(e: unknown) {
    const needs = notReadyNeeds(e)
    if (needs) toast.add({ title: 'Not ready yet', description: `Needs: ${needs}`, color: 'warning' })
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

  async function changeStatus(value: string) {
    if (!task.value || value === 'current') return
    try {
      await confirm(transitionMutation.mutateAsync({ task: address.value, ...statusMove(value) }))
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
