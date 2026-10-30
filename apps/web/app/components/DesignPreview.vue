<script setup lang="ts">
import { designPreviewUrl } from '@corral/core'
import { computed } from 'vue'
import prototypePreview from '~/prototype/design-preview.html?raw'

// A design version's prototype (D20). It's untrusted HTML, so it only ever
// runs in this iframe: allow-scripts without allow-same-origin keeps it in
// an opaque origin, away from Corral's cookies, storage and API. The server
// sends the same sandbox in the files' CSP, in case they're opened directly.
const props = defineProps<{ versionId: string, title?: string }>()
const src = computed(() => import.meta.prototype ? undefined : designPreviewUrl(props.versionId))
const srcdoc = import.meta.prototype ? prototypePreview : undefined
</script>

<template>
  <iframe
    :src="src"
    :srcdoc="srcdoc"
    :title="title ?? 'Design prototype'"
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    class="size-full border-0 bg-white"
  />
</template>
