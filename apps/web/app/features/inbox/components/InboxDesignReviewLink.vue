<script setup lang="ts">
import type { Task } from '@corral/contracts'

defineProps<{ task: Pick<Task, 'type' | 'status' | 'ref'> | null, size?: 'sm' | 'md' }>()
</script>

<template>
  <AppButton
    v-if="task?.type === 'design' && task.status === 'human_review'"
    :to="`/tasks/${task.ref}`"
    label="Review design"
    icon="i-hugeicons-layout-01"
    variant="outline"
    :size="size"
  />
</template>
