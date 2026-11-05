<script setup lang="ts">
useSeoMeta({ title: 'Home · Corral' })
// One Home on both layouts (design/home.md); a phone gets its mobile layout
const device = useDevice()
</script>

<template>
  <HomeOverview :mobile="device.isMobile.value" />
</template>
