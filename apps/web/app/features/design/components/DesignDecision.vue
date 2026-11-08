<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { DesignVersion, Task } from '@corral/contracts'
import { isDesignDecidable } from '@corral/core'
import { actOnInboxItem } from '~/queries/inbox'
import { errorMessage } from '~/lib/errors'
import { approveDesign, moveTask } from '~/queries/tasks'

// The human's say on a design version: Approve, Request changes, or Reopen
// once the design is approved
const props = defineProps<{ task: Task, slug: string, versions: DesignVersion[], selected: DesignVersion }>()
const toast = useToast()
const transition = useMutation(moveTask)
const act = useMutation(actOnInboxItem)
const approval = useMutation(approveDesign)

// Only the version waiting on the human can be decided
const decidable = computed(() => isDesignDecidable(props.task.status) && (props.selected.status === 'submitted' || (props.selected.status === 'approved' && props.selected.id === props.versions[0]?.id && !props.versions.some(v => v.status === 'submitted'))))
const reopenable = computed(() => props.task.status === 'approved')
const requesting = ref(false)
const feedback = ref('')
// Saved on the task and sent to the PM in the build Plan session
const note = ref('')
function fail(e: unknown) {
  toast.add({ title: 'Not saved', description: errorMessage(e), color: 'error' })
}
async function approve() {
  const { version } = props.selected
  try {
    await approval.mutateAsync({ task: { ...props.task, slug: props.slug }, version, note: note.value.trim() || undefined })
    toast.add({ title: `Design v${version} approved`, description: 'The PM is planning the build.', color: 'success' })
    note.value = ''
  } catch (e) {
    fail(e)
  }
}
// The feedback goes to the designer as a pinned comment, kept on the
// version too, and the task goes back to In progress (D20)
async function requestChanges(text: string): Promise<boolean> {
  try {
    if (reopenable.value) {
      await transition.mutateAsync({ task: { ...props.task, slug: props.slug }, input: { type: 'human_request_changes', feedback: text }, status: 'in_progress' })
    } else {
      await act.mutateAsync({ taskId: props.task.id, input: { action: 'request_changes', text } })
    }
    feedback.value = ''
    requesting.value = false
    toast.add({ title: 'Changes requested', description: 'The designer picks it up on the next run.', color: 'success' })
    return true
  } catch (e) {
    fail(e)
    return false
  }
}
</script>

<template>
  <div
    v-if="decidable || reopenable"
    class="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3"
  >
    <div class="flex flex-wrap items-center gap-2">
      <span class="me-auto text-sm">{{ reopenable ? 'Design approved. Reopen with feedback to request a new version.' : `v${selected.version} is waiting on your review.` }}</span>
      <AppButton
        :label="reopenable ? 'Reopen design' : 'Request changes'"
        icon="i-hugeicons-pencil-edit-02"
        variant="outline"
        color="neutral"
        size="sm"
        @click="requesting = !requesting"
      />
      <AppButton
        v-if="decidable"
        :label="`Approve v${selected.version}`"
        icon="i-hugeicons-tick-02"
        size="sm"
        :loading="approval.isPending.value"
        @click="approve"
      />
    </div>
    <AppInput
      v-if="decidable && !requesting"
      v-model="note"
      placeholder="Note for the build plan (optional)"
      aria-label="Approval note for the PM"
      size="sm"
    />
    <PromptComposer
      v-if="requesting"
      v-model="feedback"
      placeholder="What should change? Paste or drop screenshots to show it."
      hint="Goes to the designer, who submits a new version."
      submit-label="Request changes"
      :project="slug"
      @submit="requestChanges"
    />
  </div>
</template>
