<script setup lang="ts">
const { project } = useProject()
useSeoMeta({ title: () => `Pull requests · ${project.value?.name ?? ''} · Corral` })
</script>

<template>
  <ProjectPullRequests />
</template>
