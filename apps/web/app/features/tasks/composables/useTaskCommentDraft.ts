import { watch, type ComputedRef } from 'vue'
import { useMutation } from '@tanstack/vue-query'
import type { Task } from '@corral/contracts'
import { clearDraftsExcept, useDraft } from '~/composables/useDraft'
import { commentOnTask, type TaskAddress } from '~/queries/tasks'

interface TaskTarget {
  task: ComputedRef<Task | null>
  address: ComputedRef<TaskAddress>
}

// The comment box's text across task switches, and sending it
export function useTaskCommentDraft({ task, address }: TaskTarget, fail: (e: unknown) => void) {
  const commentMutation = useMutation(commentOnTask)
  const draft = useDraft(() => `task:${address.value.ref}`)
  // A comment that failed after moving on, put back on returning to its task
  const unsent = new Map<string, string>()

  // Switching tasks resets the draft; returning to this one keeps it
  watch(() => address.value.ref, (ref, previous) => {
    clearDraftsExcept(`task:${previous}`, `task:${ref}`)
    draft.value = unsent.get(ref) ?? ''
    unsent.delete(ref)
  })

  // The comment shows at once, so the box empties at once; a failure puts the
  // text back and resolves false, so the composer keeps its images
  async function send(body: string): Promise<boolean> {
    if (!task.value) return false
    const requested = address.value.ref
    const text = draft.value
    draft.value = ''
    try {
      await commentMutation.mutateAsync({ task: { ...address.value, id: task.value.id }, body })
      return true
    } catch (e) {
      if (requested !== address.value.ref) unsent.set(requested, text)
      else draft.value = draft.value ? `${text}\n\n${draft.value}` : text
      fail(e)
      return false
    }
  }

  // Passed down inside an object, so a keystroke doesn't re-render the detail
  return { draft: { text: draft }, send }
}
