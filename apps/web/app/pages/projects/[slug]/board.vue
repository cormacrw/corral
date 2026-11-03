<script setup lang="ts">
const { project } = useProject()
useSeoMeta({ title: () => `Board · ${project.value?.name ?? ''} · Corral` })
const device = useDevice()
const board = useBoard()
</script>

<template>
  <AppPanel>
    <!-- Phones get one column at a time (design/mobile.md) -->
    <BoardMobile
      v-if="device.isMobile.value"
      :board="board"
    />
    <BoardDesktop
      v-else
      :board="board"
    />
  </AppPanel>
</template>
