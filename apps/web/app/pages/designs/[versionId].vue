<script setup lang="ts">
// A design version's prototype on its own, full size: the preview link
// get_design hands out (D20)
definePageMeta({ layout: 'bare' })
const route = useRoute()
const versionId = computed(() => String(route.params.versionId))
useSeoMeta({ title: 'Design preview · Corral' })
</script>

<template>
  <main class="h-dvh">
    <DesignPreview :version-id="versionId" />
  </main>
</template>
