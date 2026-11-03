<script setup lang="ts">
// On a phone the layout bounds this single scroller above the tab bar and safe
// area. Clip the active runs' glow horizontally without nesting a scroller.
const device = useDevice()
const { overview } = useProject()
useSeoMeta({ title: () => `${overview.project.value?.name ?? 'Project'} · Corral` })
</script>

<template>
  <div
    v-if="device.isMobile.value"
    class="min-w-0 flex-1 overflow-x-hidden"
  >
    <MobilePageHeader />
    <ProjectOverview
      :overview="overview"
      mobile
    />
  </div>
  <AppPanel v-else>
    <ProjectOverview :overview="overview" />
  </AppPanel>
</template>
