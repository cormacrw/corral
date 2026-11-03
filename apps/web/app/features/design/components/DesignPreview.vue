<script setup lang="ts">
import { designPreviewUrl } from '@corral/core'
import { computed } from 'vue'

// A design version's prototype (D20). It's untrusted HTML, so it only ever
// runs in this iframe: allow-scripts without allow-same-origin keeps it in
// an opaque origin, away from Corral's cookies, storage and API. The server
// sends the same sandbox in the files' CSP, in case they're opened directly.
const props = defineProps<{ versionId: string, title?: string }>()
const src = computed(() => designPreviewUrl(props.versionId))
</script>

<template>
  <iframe
    :src="src"
    :title="title ?? 'Design prototype'"
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    class="size-full border-0 bg-white"
  />
</template>
