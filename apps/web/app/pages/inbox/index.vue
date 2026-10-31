<script setup lang="ts">
// A phone shows the list instead (design/mobile.md)
const device = useDevice()
</script>

<template>
  <div
    v-if="!device.isMobile.value"
    class="flex min-w-0 flex-1 flex-col"
  >
    <InboxEmpty />
  </div>
</template>
