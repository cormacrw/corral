<script setup lang="ts">
import type { Inbox, PlanThreadItem, ReleaseNotesItem } from '@corral/contracts'

// An Inbox item on a phone with its own layout (design/inbox.md,
// design/mobile.md), a screen at /inbox/:itemId, or the screen while there's no
// item to show. Task items use InboxPanel.
defineProps<{
  planThread: PlanThreadItem | null
  releaseNotes: ReleaseNotesItem | null
  inbox: Inbox | null
  error: string | null
  onRetry: () => unknown
}>()
</script>

<template>
  <InboxMobilePlanThread
    v-if="planThread"
    :item="planThread"
  />
  <div
    v-else
    class="flex h-full min-h-0 flex-col"
  >
    <MobilePageHeader compact />
    <InboxReleaseNotes
      v-if="releaseNotes"
      :item="releaseNotes"
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
