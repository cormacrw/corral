<script setup lang="ts">
import { useInboxItem } from '~/features/inbox/composables/useInboxItem'

// The selected Inbox item (design/inbox.md). The item's data and actions are
// useInboxItem's.
const device = useDevice()
const { ctx, panelView, epicItem, epicGone } = useInboxItem()
</script>

<template>
  <InboxMobileItem
    v-if="device.isMobile.value"
    ref="panelView"
    :epic-item="epicItem"
    :epic-gone="epicGone"
    :ctx="ctx"
  />
  <InboxItemPane
    v-else
    ref="panelView"
    :ctx="ctx"
    :epic-item="epicItem"
    :epic-gone="epicGone"
  >
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <InboxEmpty />
    </div>
  </InboxItemPane>
</template>
