<script setup lang="ts">
const { project } = useProject()
useSeoMeta({ title: () => `Settings · ${project.value?.name ?? ''} · Corral` })
</script>

<template>
  <ProjectSettings />
</template>
