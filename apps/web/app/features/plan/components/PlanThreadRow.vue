<script setup lang="ts">
import type { PlanThreadItem } from '@corral/contracts'
import { markdownToPlainText } from '~/utils/markdown'
import { inboxTitlePrefix } from '~/features/inbox/utils/inbox-title'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// Laid out like the other Inbox rows, which differ by layout
defineProps<{ item: PlanThreadItem, mobile?: boolean }>()
</script>

<template>
  <span
    v-if="item.unread"
    class="mt-2 size-2 shrink-0 rounded-full bg-primary"
    aria-label="Unread"
  />
  <AgentAvatar
    :name="item.sender.name"
    :size="mobile ? 'md' : 'xs'"
  />
  <span :class="['min-w-0 flex-1', mobile && 'flex flex-col gap-1']">
    <span :class="['flex items-center gap-2', !mobile && 'text-xs text-muted-foreground']">
      <span :class="mobile ? 'font-semibold text-foreground' : 'font-medium text-foreground'">{{ item.sender.name }}</span>
      <span class="ms-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <Icon
          v-if="item.activeRunId"
          name="i-hugeicons-loading-03"
          class="size-3 animate-spin"
          aria-label="PM working"
        />
        <TimeAgo :at="item.at" />
      </span>
    </span>
    <span :class="mobile ? 'font-semibold text-foreground' : 'block truncate text-sm font-medium'"><span class="text-muted-foreground">{{ inboxTitlePrefix(item) }}:</span> {{ item.subject }}</span>
    <span :class="['line-clamp-2 text-muted-foreground', mobile ? 'text-sm' : 'text-xs']">{{ markdownToPlainText(item.preview) }}</span>
    <span :class="['flex min-w-0 items-center gap-1 text-xs text-muted-foreground', mobile ? 'mt-0.5' : 'mt-1']">
      <ProjectThumbnail
        v-if="item.project"
        :project="item.project"
        :size="16"
      />
      <span class="truncate">{{ item.project?.name ?? 'Global' }}</span>
    </span>
  </span>
</template>
