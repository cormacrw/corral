<script setup lang="ts">
import type { InboxItem } from '@corral/contracts'
import { markdownToPlainText } from '~/utils/markdown'
import TimeAgo from '~/components/shared/TimeAgo.vue'
import { inboxTitlePrefix } from '~/features/inbox/utils/inbox-title'

// One Inbox row's content, on either layout. A Plan thread has PlanThreadRow.
const props = defineProps<{ item: Exclude<InboxItem, { type: 'plan_thread' }>, mobile?: boolean }>()
const prefix = computed(() => inboxTitlePrefix(props.item))
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
      <span :class="['min-w-0 truncate', mobile ? 'font-semibold text-foreground' : 'font-medium text-foreground']">{{ item.sender.name }}</span>
      <span class="ms-auto shrink-0 text-xs text-muted-foreground"><TimeAgo :at="item.at" /></span>
    </span>
    <span :class="mobile ? 'font-semibold text-foreground' : 'block truncate text-sm font-medium'"><span
      v-if="prefix"
      class="text-muted-foreground"
    >{{ prefix }}: </span>{{ item.subject }}</span>
    <span :class="['line-clamp-2 text-muted-foreground', mobile ? 'text-sm' : 'text-xs']">{{ markdownToPlainText(item.preview) }}</span>
    <span
      v-if="item.type === 'release_notes'"
      :class="['font-mono text-xs text-muted-foreground', !mobile && 'block']"
    >{{ item.fromSha ? `${item.fromSha}…` : '' }}{{ item.toSha }}</span>
    <span
      v-if="item.project"
      :class="['flex min-w-0 items-center gap-1 text-xs text-muted-foreground', mobile ? 'mt-0.5' : 'mt-1']"
    >
      <ProjectThumbnail
        :project="item.project"
        :size="16"
      />
      <span class="truncate">{{ item.project.name }}<template v-if="mobile && item.taskRef"> · {{ item.taskRef }}</template></span>
    </span>
  </span>
</template>
