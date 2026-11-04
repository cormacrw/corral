<script setup lang="ts">
import type { PlanThreadItem } from '@corral/contracts'
import { computed } from 'vue'
import { markdownToPlainText } from '~/utils/markdown'
import { inboxTitlePrefix } from '~/features/inbox/utils/inbox-title'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// Laid out like the other Inbox rows, which differ by layout
const props = defineProps<{ item: PlanThreadItem, mobile?: boolean }>()
// Unread is bold, full-strength text, the way a mail client shows it
const tone = computed(() => props.item.unread ? 'text-foreground' : 'text-muted-foreground')
</script>

<template>
  <AgentAvatar
    :name="item.sender.name"
    :size="mobile ? 'md' : 'xs'"
  />
  <span :class="['min-w-0 flex-1', mobile && 'flex flex-col gap-1', item.unread && 'font-semibold']">
    <span
      v-if="item.unread"
      class="sr-only"
      aria-label="Unread"
    >Unread</span>
    <span :class="['flex items-center gap-2', !mobile && 'text-xs', tone]">
      <span :class="[tone, item.unread ? 'font-bold' : mobile ? 'font-semibold' : 'font-medium']">{{ item.sender.name }}</span>
      <span :class="['ms-auto flex shrink-0 items-center gap-2 text-xs', tone]">
        <Icon
          v-if="item.activeRunId"
          name="i-hugeicons-loading-03"
          class="size-3 animate-spin"
          aria-label="PM working"
        />
        <TimeAgo :at="item.at" />
      </span>
    </span>
    <span :class="[tone, !mobile && 'block truncate text-sm', item.unread ? 'font-bold' : mobile ? 'font-semibold' : 'font-medium']"><span :class="tone">{{ inboxTitlePrefix(item) }}:</span> {{ item.subject }}</span>
    <span :class="['line-clamp-2', tone, mobile ? 'text-sm' : 'text-xs']">{{ markdownToPlainText(item.preview) }}</span>
    <span :class="['flex min-w-0 items-center gap-1 text-xs', tone, mobile ? 'mt-0.5' : 'mt-1']">
      <ProjectThumbnail
        v-if="item.project"
        :project="item.project"
        :size="18"
      />
      <span class="truncate">{{ item.project?.name ?? 'Global' }}</span>
    </span>
  </span>
</template>
