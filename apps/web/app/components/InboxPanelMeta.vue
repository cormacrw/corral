<script setup lang="ts">
import type { InboxPanel } from '~/composables/useInboxPanel'
import { inboxProjectLine, timeAgo } from '~/utils/labels'

// What the item is, as one quiet line: kind, project · ref, who and when
defineProps<{ p: InboxPanel }>()
</script>

<template>
  <p
    class="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted"
    data-testid="inbox-meta"
  >
    <UIcon
      :name="p.kind.value.icon"
      :class="['size-3.5 shrink-0', p.kind.value.color]"
    />
    <span class="font-medium text-default">{{ p.kind.value.label }}</span>
    <span aria-hidden="true">·</span>
    <ProjectThumbnail
      :project="p.item.value.project"
      :size="14"
    />
    <span class="truncate">{{ inboxProjectLine(p.item.value) }} · {{ p.item.value.sender.name }} · {{ timeAgo(p.item.value.at) }}</span>
  </p>
</template>
