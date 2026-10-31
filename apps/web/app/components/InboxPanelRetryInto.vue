<script setup lang="ts">
import type { InboxPanelContext, ResolveTo } from '~/composables/useInboxPanel'

// The status Retry starts the task from
defineProps<{ ctx: InboxPanelContext, size: 'sm' | 'md' }>()
</script>

<template>
  <USelectMenu
    :model-value="ctx.resolveTo"
    :items="[{ label: 'In progress', value: 'in_progress' }, { label: 'Ready', value: 'ready' }, { label: 'Backlog', value: 'backlog' }]"
    value-key="value"
    :size="size"
    :search-input="false"
    aria-label="Retry into"
    class="w-32"
    @update:model-value="ctx.setResolveTo($event as ResolveTo)"
  />
</template>
