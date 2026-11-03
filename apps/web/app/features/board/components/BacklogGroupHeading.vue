<script setup lang="ts">
import type { BacklogGroup } from '~/features/board/utils/backlog'

// A Backlog group's collapse toggle, size and progress
defineProps<{ group: BacklogGroup, collapsed: boolean, mobile?: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    :class="['flex min-w-0 items-center gap-1', mobile ? 'font-semibold text-foreground' : 'max-w-full font-medium']"
    :aria-expanded="!collapsed"
    @click="emit('toggle')"
  >
    <Icon
      name="i-hugeicons-arrow-right-01"
      :class="['size-4 shrink-0 transition-transform', !collapsed && 'rotate-90']"
    />
    <span class="truncate">{{ group.title }}</span>
  </button>
  <AppBadge
    :label="String(group.rows.length)"
    size="xs"
    variant="subtle"
    color="neutral"
  />
  <span class="text-xs text-muted-foreground">{{ group.merged }} of {{ group.total }} done</span>
</template>
