<script setup lang="ts">
import { useInboxView } from '~/features/inbox/composables/useInboxView'
import InboxList from '~/features/inbox/components/InboxList.vue'
import { provideFlyoutHost } from '~/composables/useTaskFlyout'

// The Inbox (design/inbox.md, D11): list and task flyout around the selected
// item, which is the default slot.
const device = useDevice()
const { selectedId, selected } = useInboxView()
const docked = computed(() => !device.isMobile.value && selected.value?.type !== 'plan_thread')
provideFlyoutHost({ docked: () => docked.value })
</script>

<template>
  <AppPanel>
    <div :class="['flex h-full min-h-0', device.isMobile.value ? 'flex-col' : 'max-md:flex-col']">
      <!-- Phones get the list and the item as separate screens (design/mobile.md) -->
      <InboxMobile
        v-if="device.isMobile.value"
        v-show="!selectedId"
      />
      <InboxList v-else />

      <!-- Always rendered: the shell's route only catches up when a child finishes -->
      <div class="flex min-h-0 min-w-0 flex-1 max-[1100px]:flex-col">
        <slot />
        <TaskFlyout v-if="docked" />
      </div>
    </div>
  </AppPanel>
</template>
