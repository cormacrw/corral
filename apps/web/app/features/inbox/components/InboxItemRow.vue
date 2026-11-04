<script setup lang="ts">
import type { InboxItem } from '@corral/contracts'
import { markdownToPlainText } from '~/utils/markdown'
import TimeAgo from '~/components/shared/TimeAgo.vue'
import { inboxTitlePrefix } from '~/features/inbox/utils/inbox-title'

// One Inbox row's content, on either layout. A Plan thread has PlanThreadRow.
const props = defineProps<{ item: Exclude<InboxItem, { type: 'plan_thread' }>, mobile?: boolean }>()
const prefix = computed(() => inboxTitlePrefix(props.item))
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
      <span :class="['min-w-0 truncate', tone, item.unread ? 'font-bold' : mobile ? 'font-semibold' : 'font-medium']">{{ item.sender.name }}</span>
      <span :class="['ms-auto shrink-0 text-xs', tone]"><TimeAgo :at="item.at" /></span>
    </span>
    <span :class="[tone, !mobile && 'block truncate text-sm', item.unread ? 'font-bold' : mobile ? 'font-semibold' : 'font-medium']"><span
      v-if="prefix"
      :class="tone"
    >{{ prefix }}: </span>{{ item.subject }}</span>
    <span :class="['line-clamp-2', tone, mobile ? 'text-sm' : 'text-xs']">{{ markdownToPlainText(item.preview) }}</span>
    <span
      v-if="item.type === 'release_notes'"
      :class="['font-mono text-xs', tone, !mobile && 'block']"
    >{{ item.fromSha ? `${item.fromSha}…` : '' }}{{ item.toSha }}</span>
    <span
      v-if="item.project"
      :class="['flex min-w-0 items-center gap-1 text-xs', tone, mobile ? 'mt-0.5' : 'mt-1']"
    >
      <ProjectThumbnail
        :project="item.project"
        :size="18"
      />
      <span class="truncate">{{ item.project.name }}<template v-if="mobile && item.taskRef"> · {{ item.taskRef }}</template></span>
    </span>
  </span>
</template>
