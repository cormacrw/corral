<script setup lang="ts">
import type { PlanThreadItem } from '@corral/contracts'
import { projectColor, timeAgo } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'

defineProps<{ item: PlanThreadItem }>()
</script>

<template>
  <span
    class="mt-1.5 size-2.5 shrink-0 rounded-full"
    :style="{ background: projectColor(item.project) }"
    :title="item.project.name"
    :aria-label="item.project.name"
  />
  <span class="flex min-w-0 flex-1 flex-col gap-1">
    <span class="flex items-center gap-2">
      <span class="truncate text-sm font-semibold">{{ item.subject }}</span>
      <span
        v-if="item.unread"
        class="size-2 shrink-0 rounded-full bg-primary"
        aria-label="Unread reply"
      />
      <UIcon
        v-if="item.activeRunId"
        name="i-lucide-loader-circle"
        class="ms-auto size-3 shrink-0 animate-spin"
        aria-label="PM working"
      />
      <span class="ms-auto shrink-0 text-xs text-muted">{{ timeAgo(item.at) }}</span>
    </span>
    <span class="text-xs text-muted">{{ item.project.name }}</span>
    <span class="line-clamp-2 text-xs text-muted">{{ markdownToPlainText(item.preview) }}</span>
    <UBadge
      v-if="item.status !== 'none' || item.unread"
      :label="item.status === 'needs_approval' ? 'Needs approval' : item.status === 'question' ? 'Question' : 'Unread reply'"
      :color="item.status === 'needs_approval' ? 'primary' : item.status === 'question' ? 'info' : 'neutral'"
      variant="subtle"
      size="xs"
      class="self-start"
    />
  </span>
</template>
