<script setup lang="ts">
import type { EpicActivityItem } from '@corral/contracts'
import { timeAgo } from '~/utils/labels'

// Read-only fallback until epic history uses the full epic panel.
defineProps<{ item: EpicActivityItem }>()
const device = useDevice()
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col"
    data-testid="inbox-epic-activity"
  >
    <MobilePageHeader
      v-if="device.isMobile.value"
      compact
    />
    <div class="flex flex-col gap-4 overflow-y-auto p-5">
      <p class="text-xs text-muted">
        {{ item.resolution ? 'Resolved' : 'Activity' }} · {{ item.project.name }} · {{ item.sender.name }} · {{ timeAgo(item.at) }}
      </p>
      <h1 class="text-lg font-semibold text-highlighted">
        {{ item.subject }}
      </h1>
      <InboxMessage :item="item" />
      <p
        v-if="item.resolution !== item.body"
        class="text-sm text-muted"
      >
        {{ item.resolution ?? 'For your information. Nothing to do.' }}
      </p>
      <div class="flex flex-wrap gap-2">
        <UButton
          :to="`/epics/${item.epicId}`"
          label="Open epic"
          color="neutral"
          variant="outline"
        />
        <UButton
          v-if="item.prUrl"
          :to="item.prUrl"
          target="_blank"
          label="Open PR"
          icon="i-lucide-git-pull-request"
          color="neutral"
          variant="outline"
        />
      </div>
    </div>
  </div>
</template>
