<script setup lang="ts">
import type { TaskAgent } from '@corral/contracts'

defineProps<{
  agent: TaskAgent | null
  working: boolean
  size?: '2xs' | 'xs' | 'sm'
  avatarOnly?: boolean
  emphasis?: boolean
}>()
</script>

<template>
  <span
    class="flex min-w-0 items-center gap-1.5"
    :title="agent?.name ?? 'Unassigned'"
  >
    <template v-if="agent">
      <AgentAvatar
        :name="agent.name"
        :working="working"
        :size="size ?? 'xs'"
      />
      <span
        v-if="!avatarOnly"
        :class="['truncate', emphasis ? 'text-xs font-semibold text-highlighted' : 'font-medium text-default']"
      >{{ agent.name }}</span>
    </template>
    <template v-else>
      <UIcon
        name="i-lucide-circle-dashed"
        :class="['shrink-0 text-dimmed', size === 'sm' ? 'size-7' : size === '2xs' ? 'size-5' : 'size-6']"
      />
      <span
        v-if="!avatarOnly"
        class="truncate text-xs text-dimmed"
      >Unassigned</span>
    </template>
  </span>
</template>
