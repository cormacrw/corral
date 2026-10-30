<script setup lang="ts">
import type { TaskAgent } from '@corral/contracts'

// The face only: a dashed circle when nobody holds the task
defineProps<{ agent: TaskAgent | null, working: boolean }>()
</script>

<template>
  <span
    class="flex shrink-0"
    :title="agent?.name ?? 'Unassigned'"
  >
    <AgentAvatar
      v-if="agent"
      :name="agent.name"
      :working="working"
      size="xs"
    />
    <UIcon
      v-else
      name="i-lucide-circle-dashed"
      role="img"
      aria-label="Unassigned"
      class="size-6 text-dimmed"
    />
  </span>
</template>
