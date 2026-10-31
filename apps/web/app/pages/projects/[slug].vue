<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { projectsQuery } from '~/queries/projects'

// Wraps every /projects/:slug route, so none of them has to handle a project
// that isn't there. Until the list loads, pages show their own skeletons.
const route = useRoute()
const { data: projects } = useQuery(projectsQuery())
// The project being removed here is about to be left, not missing
const removing = useRemovingProject()
const missing = computed(() => removing.value !== route.params.slug && (projects.value?.every(p => p.slug !== route.params.slug) ?? false))
</script>

<template>
  <ProjectNotFound v-if="missing" />
  <NuxtPage v-else />
</template>
