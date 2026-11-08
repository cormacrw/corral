<script setup lang="ts">
import type { InboxComposerContext } from '~/features/inbox/composables/useInboxPanel'
import InboxPanelActions from '~/features/inbox/components/InboxPanelActions.vue'

// What an item that can be acted on has at the bottom of its panel: the
// actions, and the composer once an action that takes words is chosen. On a
// phone (design/mobile.md) it is the thumb bar. The default slot goes above
// the actions on a wide screen.
const props = defineProps<{ ctx: InboxComposerContext, mobile?: boolean, composer: boolean, approveLabel?: string }>()
const bar = ref<{ send: () => Promise<boolean> } | null>(null)
const tray = ref<{ send: () => Promise<boolean> } | null>(null)
// Through the composer when it's open, for its images
defineExpose({ send: () => (props.mobile ? bar : tray).value?.send() ?? null })
</script>

<template>
  <InboxPanelThumbBar
    v-if="mobile"
    ref="bar"
    :ctx="ctx"
    :approve-label="approveLabel"
  />
  <div
    v-else
    class="flex shrink-0 flex-col gap-2 border-t border-border p-3"
  >
    <slot />
    <InboxPanelActions
      :ctx="ctx"
      can-act
    />
    <InboxPanelTray
      v-if="composer"
      ref="tray"
      :ctx="ctx"
    />
    <AppAlert
      v-else-if="ctx.actionError"
      color="error"
      variant="subtle"
      :title="ctx.actionError"
    />
  </div>
</template>
