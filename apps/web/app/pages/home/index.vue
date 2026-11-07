<script setup lang="ts">
useSeoMeta({ title: 'Home · Corral' })
// One Home on every device; a phone gets its mobile layout (design/mobile.md#home)
const device = useDevice()
</script>

<template>
  <HomeOverview :mobile="device.isMobile.value" />
</template>
