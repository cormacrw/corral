<script setup lang="ts">
import type { Task } from '@corral/contracts'

defineProps<{ task: Pick<Task, 'type' | 'status' | 'ref'> | null }>()
</script>

<template>
  <UButton
    v-if="task?.type === 'design' && task.status === 'human_review'"
    :to="`/tasks/${task.ref}`"
    label="Review design"
    icon="i-lucide-panels-top-left"
    variant="outline"
  />
</template>
