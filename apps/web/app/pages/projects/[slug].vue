<script setup lang="ts">
// Wraps every /projects/:slug route: it resolves the project once for its tabs
// (useProject) and shows the one not-found state. Until the list loads, pages
// show their own skeletons.
definePageMeta({ taskFlyout: true })

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const missing = useProjectMissing(slug)
provideProject(slug, missing, () => route.name === 'projects-slug')
</script>

<template>
  <ProjectNotFound v-if="missing" />
  <NuxtPage v-else />
</template>
