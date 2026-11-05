<script setup lang="ts">
useSeoMeta({ title: 'Home · Corral' })
// A phone keeps its own single-column dashboard (design/mobile.md)
const device = useDevice()
</script>

<template>
  <HomeDashboard v-if="device.isMobile.value" />
  <HomeOverview v-else />
</template>
