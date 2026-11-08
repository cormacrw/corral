<script setup lang="ts">
import { computed } from 'vue'
import { deletionFor } from '@corral/core'
import type { Task } from '@corral/contracts'

// Delete, with its confirmation. The mobile screen opens it from the header's menu.
const props = defineProps<{ task: Task, mobile: boolean, removing: boolean }>()
const emit = defineEmits<{ remove: [] }>()
const open = defineModel<boolean>('open', { default: false })
const description = computed(() => deletionFor(props.task) === 'hard'
  ? 'This task is deleted outright.'
  : 'Stops any run, closes the PR and deletes the branch when safe. The task and its history are kept but hidden. Dependents become Blocked.')
</script>

<template>
  <section :class="mobile ? 'hidden' : 'border-t border-border pt-3'">
    <AppButton
      label="Delete task"
      icon="i-hugeicons-delete-02"
      color="error"
      variant="ghost"
      size="sm"
      @click="open = true"
    />
    <AppModal
      v-model:open="open"
      :title="`Delete ${task.ref}?`"
      :description="description"
    >
      <template #footer>
        <AppButton
          label="Cancel"
          variant="outline"
          color="neutral"
          @click="open = false"
        />
        <AppButton
          label="Delete"
          color="error"
          :loading="removing"
          @click="emit('remove')"
        />
      </template>
    </AppModal>
  </section>
</template>
