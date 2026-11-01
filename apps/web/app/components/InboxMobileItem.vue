<script setup lang="ts">
import type { EpicConflictItem, EpicReviewItem, Inbox, PlanThreadItem, PmActivityItem, TaskInboxItem, ReleaseNotesItem } from '@corral/contracts'
import type { InboxPanelContext } from '~/composables/useInboxPanel'
import { inboxItemLink } from '~/utils/labels'

// An Inbox item on a phone (design/inbox.md, design/mobile.md), a screen of its
// own at /inbox/:itemId. The page owns the data and the actions; task items are
// the Option D panel under the focused header.
const props = defineProps<{
  planThread: PlanThreadItem | null
  epicItem: EpicReviewItem | EpicConflictItem | null
  inbox: Inbox | null
  error: string | null
  selected: TaskInboxItem | PmActivityItem | ReleaseNotesItem | null
  ctx: InboxPanelContext
  onRetry: () => unknown
  onResolved: () => unknown
}>()
const panel = ref<{ send: () => Promise<boolean> } | null>(null)
defineExpose({ send: () => panel.value?.send() ?? Promise.resolve(false) })
const taskLink = computed(() => {
  const link = props.selected ? inboxItemLink(props.selected) : null
  // An item can outlive its task, and then there's no task page to open
  return link?.label === 'Task' && !props.ctx.task ? null : link
})
</script>

<template>
  <InboxMobilePlanThread
    v-if="planThread"
    :item="planThread"
  />
  <div
    v-else-if="epicItem"
    class="flex h-full min-h-0 flex-col"
  >
    <MobilePageHeader compact />
    <InboxEpicReview
      v-if="epicItem.type === 'epic_review'"
      :item="epicItem"
      @resolved="onResolved"
    />
    <InboxEpicConflict
      v-else
      :item="epicItem"
      @resolved="onResolved"
    />
  </div>
  <div
    v-else-if="selected?.type === 'release_notes'"
    class="flex h-full min-h-0 flex-col"
  >
    <MobilePageHeader compact />
    <InboxReleaseNotes
      :item="selected"
    />
  </div>
  <div
    v-else
    class="flex h-full min-h-0 flex-col"
    data-testid="inbox-item"
  >
    <MobilePageHeader compact>
      <template #actions>
        <UButton
          v-if="taskLink"
          :to="taskLink.to"
          :label="taskLink.label"
          icon="i-lucide-list"
          class="tap-target"
          variant="ghost"
          color="neutral"
        />
      </template>
    </MobilePageHeader>
    <InboxPanel
      v-if="selected"
      ref="panel"
      :ctx="ctx"
      mobile
    />
    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      :title="error"
      class="m-4"
      :actions="[{ label: 'Retry', onClick: onRetry }]"
    />
    <div
      v-else-if="!inbox"
      class="flex flex-col gap-3 p-4"
    >
      <USkeleton class="h-12 w-full" />
      <USkeleton class="h-32 w-full" />
    </div>
    <div
      v-else
      class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted"
    >
      This item isn't in your Inbox any more.
      <UButton
        to="/inbox"
        label="Back to Inbox"
        color="neutral"
        variant="outline"
      />
    </div>
  </div>
</template>
