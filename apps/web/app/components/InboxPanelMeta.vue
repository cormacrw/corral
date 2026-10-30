<script setup lang="ts">
import type { InboxPanel } from '~/composables/useInboxPanel'
import { timeAgo } from '~/utils/labels'

// What the item is, as one quiet line: kind, project · ref, who and when
defineProps<{ p: InboxPanel, kind?: boolean }>()
</script>

<template>
  <p class="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted">
    <template v-if="kind">
      <UIcon
        :name="p.kind.value.icon"
        :class="['size-3.5 shrink-0', p.kind.value.color]"
      />
      <span class="font-medium text-default">{{ p.kind.value.label }}</span>
      <span aria-hidden="true">·</span>
    </template>
    <span
      class="size-2 shrink-0 rounded-full"
      :style="{ background: p.item.value.project.thumbnailColor ?? '#64748b' }"
      aria-hidden="true"
    />
    <span class="truncate">{{ p.item.value.project.name }} · {{ p.item.value.taskRef }} · {{ p.item.value.sender.name }} · {{ timeAgo(p.item.value.at) }}</span>
  </p>
</template>
