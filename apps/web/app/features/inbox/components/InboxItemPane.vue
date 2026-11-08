<script setup lang="ts">
import type { InboxPanelContext } from '~/features/inbox/composables/useInboxPanel'
import { useInboxView, type EpicInboxItem } from '~/features/inbox/composables/useInboxView'

// The pane the selected item's kind needs (utils/inbox-kinds.ts), on either
// layout. A phone shows a Plan thread as a screen of its own, around this.
// The default slot is what shows with nothing selected.
const props = defineProps<{ ctx: InboxPanelContext, epicItem: EpicInboxItem | null, epicGone?: boolean, mobile?: boolean }>()
const { selected, moveToNext } = useInboxView()
const panel = ref<{ send: () => Promise<boolean> } | null>(null)
defineExpose({ send: () => panel.value?.send() ?? Promise.resolve(false) })
</script>

<template>
  <InboxEpicPanel
    v-if="props.epicItem"
    :key="props.epicItem.id"
    :item="props.epicItem"
    :gone="props.epicGone"
    :mobile="props.mobile"
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
  />
  <InboxPanel
    v-else-if="selected"
    ref="panel"
    :ctx="props.ctx"
    :mobile="props.mobile"
  />
  <slot v-else />
</template>
