<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { STATUS } from '~/utils/labels'

// Why a task isn't moving. Above the mobile tabs, so it shows on both.
defineProps<{ task: Task, mobile: boolean, resuming: boolean }>()
const emit = defineEmits<{ resume: [] }>()
</script>

<template>
  <AppAlert
    v-if="task.status === 'blocked' || task.status === 'failed'"
    color="error"
    variant="subtle"
    :title="STATUS[task.status].label"
    :description="task.statusReason"
    class="w-auto"
    data-testid="task-status-reason"
  />
  <div
    v-if="task.paused"
    :class="['flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm', mobile && '-mt-2']"
    data-testid="task-paused"
  >
    <Icon
      name="i-hugeicons-pause"
      class="size-4 shrink-0 text-warning"
    />
    <span class="min-w-0 flex-1"><span class="font-medium">Paused.</span> <span class="text-muted-foreground">Its run was stopped, so nothing picks it up until you resume it.</span></span>
    <AppButton
      label="Resume"
      icon="i-hugeicons-play"
      size="sm"
      :class="mobile && 'min-h-11'"
      :loading="resuming"
      @click="emit('resume')"
    />
  </div>
</template>
