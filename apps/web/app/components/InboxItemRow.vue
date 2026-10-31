<script setup lang="ts">
import type { InboxItem } from '@corral/contracts'
import { inboxTypeBadge } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'
import TimeAgo from './TimeAgo.vue'

// One Inbox row's content, on either layout. A Plan thread has PlanThreadRow.
defineProps<{ item: Exclude<InboxItem, { type: 'plan_thread' }>, mobile?: boolean }>()
</script>

<template>
  <span
    v-if="item.type === 'release_notes' && item.unread"
    class="mt-2 size-2 shrink-0 rounded-full bg-primary"
    aria-label="Unread"
  />
  <AgentAvatar
    :name="item.sender.name"
    :size="mobile ? 'md' : 'xs'"
  />
  <span :class="['min-w-0 flex-1', mobile && 'flex flex-col gap-1']">
    <span :class="['flex items-center gap-2', !mobile && 'text-xs text-muted']">
      <span :class="['min-w-0 truncate', mobile ? 'font-semibold text-highlighted' : 'font-medium text-default']">{{ item.sender.name }}</span>
      <span class="ms-auto shrink-0 text-xs text-muted"><TimeAgo :at="item.at" /></span>
    </span>
    <span :class="mobile ? 'font-semibold text-highlighted' : 'block truncate text-sm font-medium'">{{ item.subject }}</span>
    <span :class="['line-clamp-2 text-muted', mobile ? 'text-sm' : 'text-xs']">{{ markdownToPlainText(item.preview) }}</span>
    <span
      v-if="item.type === 'release_notes'"
      :class="['font-mono text-xs text-muted', !mobile && 'block']"
    >{{ item.fromSha ? `${item.fromSha}…` : '' }}{{ item.toSha }}</span>
    <span :class="['flex items-center gap-2', mobile ? 'mt-0.5' : 'mt-1']">
      <UBadge
        :label="inboxTypeBadge(item.type).label"
        :color="inboxTypeBadge(item.type).color"
        variant="subtle"
        :size="mobile ? 'sm' : 'xs'"
        class="shrink-0"
      />
      <span class="flex min-w-0 items-center gap-1 text-xs text-muted">
        <ProjectThumbnail
          :project="item.project"
          :size="16"
        />
        <span class="truncate">{{ item.project.name }}<template v-if="mobile && item.taskRef"> · {{ item.taskRef }}</template></span>
      </span>
    </span>
  </span>
</template>
