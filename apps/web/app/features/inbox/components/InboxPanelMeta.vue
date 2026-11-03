<script setup lang="ts">
import type { InboxItemKind, InboxPanelContext } from '~/features/inbox/composables/useInboxPanel'
import { timeAgo } from '~/utils/labels'

// What the item is, as one quiet line: kind, project · ref, who and when
defineProps<{ kind: InboxItemKind, item: Pick<InboxPanelContext['item'], 'project' | 'taskRef' | 'sender' | 'at'> }>()
</script>

<template>
  <p
    class="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground"
    data-testid="inbox-meta"
  >
    <Icon
      :name="kind.icon"
      :class="['size-3.5 shrink-0', kind.color]"
    />
    <span class="font-medium text-foreground">{{ kind.label }}</span>
    <span aria-hidden="true">·</span>
    <ProjectThumbnail
      :project="item.project"
      :size="14"
    />
    <span class="truncate">{{ item.project?.name ?? 'Global' }}<template v-if="item.taskRef"> · <TaskLink :task-ref="item.taskRef" /></template> · {{ item.sender.name }} · {{ timeAgo(item.at) }}</span>
  </p>
</template>
