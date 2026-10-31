<script setup lang="ts">
import { clearDraftsExcept } from '~/composables/useDraft'

// A phone shows the list instead (design/mobile.md)
const device = useDevice()
// Back at the list, no item is being replied to any more
clearDraftsExcept('inbox:', '')
</script>

<template>
  <div
    v-if="!device.isMobile.value"
    class="flex min-h-0 min-w-0 flex-1 flex-col"
  >
    <InboxEmpty />
  </div>
</template>
