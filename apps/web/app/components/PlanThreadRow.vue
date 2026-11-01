<script setup lang="ts">
import type { PlanThreadItem } from '@corral/contracts'
import { markdownToPlainText } from '~/utils/markdown'
import TimeAgo from '~/components/TimeAgo.vue'

// Laid out like the other Inbox rows, which differ by layout
defineProps<{ item: PlanThreadItem, mobile?: boolean }>()
</script>

<template>
  <span
    v-if="item.unread"
    class="mt-2 size-2 shrink-0 rounded-full bg-primary"
    aria-label="Unread reply"
  />
  <AgentAvatar
    :name="item.sender.name"
    :size="mobile ? 'md' : 'xs'"
  />
  <span :class="['min-w-0 flex-1', mobile && 'flex flex-col gap-1']">
    <span :class="['flex items-center gap-2', !mobile && 'text-xs text-muted']">
      <span :class="mobile ? 'font-semibold text-highlighted' : 'font-medium text-default'">{{ item.sender.name }}</span>
      <span class="ms-auto flex shrink-0 items-center gap-2 text-xs text-muted">
        <UIcon
          v-if="item.activeRunId"
          name="i-lucide-loader-circle"
          class="size-3 animate-spin"
          aria-label="PM working"
        />
        <TimeAgo :at="item.at" />
      </span>
    </span>
    <span :class="mobile ? 'font-semibold text-highlighted' : 'block truncate text-sm font-medium'">{{ item.subject }}</span>
    <span :class="['line-clamp-2 text-muted', mobile ? 'text-sm' : 'text-xs']">{{ markdownToPlainText(item.preview) }}</span>
    <span :class="['flex items-center gap-2', mobile ? 'mt-0.5' : 'mt-1']">
      <UBadge
        v-if="item.status !== 'none' || item.unread"
        :label="item.status === 'needs_approval' ? 'Needs approval' : item.status === 'question' ? 'Question' : 'Unread reply'"
        :color="item.status === 'needs_approval' ? 'primary' : item.status === 'question' ? 'info' : 'neutral'"
        variant="subtle"
        :size="mobile ? 'sm' : 'xs'"
      />
      <span class="flex min-w-0 items-center gap-1 text-xs text-muted">
        <ProjectThumbnail
          v-if="item.project"
          :project="item.project"
          :size="16"
        />
        <span class="truncate">{{ item.project?.name ?? 'Global' }}</span>
      </span>
    </span>
  </span>
</template>
