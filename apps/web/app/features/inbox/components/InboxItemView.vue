<script setup lang="ts">
import { useInboxItem } from '~/features/inbox/composables/useInboxItem'
import { useInboxView } from '~/features/inbox/composables/useInboxView'

// The selected Inbox item (design/inbox.md): whichever pane its kind needs. The
// item's data and actions are useInboxItem's.
const device = useDevice()
const { selected, moveToNext, deleteThread } = useInboxView()
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
  <InboxEpicPanel
    v-else-if="epicItem"
    :key="epicItem.id"
    :item="epicItem"
    :gone="epicGone"
    @resolved="moveToNext"
  />
  <InboxRunnerUpdate
    v-else-if="selected?.type === 'runner_update'"
    :item="selected"
  />
  <InboxReleaseNotes
    v-else-if="selected?.type === 'release_notes'"
    :item="selected"
  />
  <InboxPlanThread
    v-else-if="selected?.type === 'plan_thread'"
    :item="selected"
    @approved="moveToNext"
    @delete="deleteThread(selected)"
  />
  <InboxPanel
    v-else-if="selected"
    ref="panelView"
    :ctx="ctx"
  />
  <div
    v-else
    class="flex min-h-0 min-w-0 flex-1 flex-col"
  >
    <InboxEmpty />
  </div>
</template>
