<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
import { useMutation } from '@tanstack/vue-query'
import { removeTask } from '~/queries/tasks'

// The parent task above an epic's work: its ref, adding a sub-task, and deleting
// a parent that has none left
const props = defineProps<{
  parent: { slug: string, number: number, ref: string }
  empty: boolean
  merged: boolean
}>()
const emit = defineEmits<{ deleted: [] }>()
const removing = useMutation(removeTask)
const confirming = ref(false)
const error = ref<string | null>(null)
async function remove() {
  error.value = null
  try {
    await removing.mutateAsync({ task: props.parent })
    confirming.value = false
    emit('deleted')
  } catch (e) {
    error.value = errorMessage(e)
  }
}
</script>

<template>
  <div class="flex items-center gap-3">
    <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ parent.ref }}</span>
    <AppButton
      v-if="empty"
      label="Delete"
      icon="i-hugeicons-delete-02"
      size="sm"
      variant="ghost"
      color="error"
      @click="confirming = true"
    />
    <AppModal
      v-model:open="confirming"
      :title="`Delete ${parent.ref}?`"
      description="It has no sub-tasks left. Any comments and history are kept with the record."
    >
      <template #body>
        <p
          v-if="error"
          class="text-sm text-destructive"
          role="alert"
        >
          {{ error }}
        </p>
      </template>
      <template #footer>
        <AppButton
          label="Cancel"
          variant="outline"
          color="neutral"
          @click="confirming = false"
        />
        <AppButton
          label="Delete"
          color="error"
          :loading="removing.isPending.value"
          @click="remove"
        />
      </template>
    </AppModal>
    <AddSubtask
      v-if="!merged"
      :slug="parent.slug"
      :number="parent.number"
      class="min-w-0 flex-1 justify-end"
    />
  </div>
</template>
