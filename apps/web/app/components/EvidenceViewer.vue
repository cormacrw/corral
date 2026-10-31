<script setup lang="ts">
import type { Evidence } from '@corral/contracts'
import { ref, watch } from 'vue'
import { timeAgo } from '~/utils/labels'

export type ViewerFile = Pick<Evidence, 'id' | 'fileName' | 'kind' | 'createdAt' | 'note' | 'url' | 'contentType'>
const open = defineModel<ViewerFile | null>({ required: true })
const isImage = (e: ViewerFile) => !!e.contentType?.startsWith('image/')
const isVideo = (e: ViewerFile) => !!e.contentType?.startsWith('video/')
// Logs, test output and requests: shown as text in the app's theme, not in
// an iframe where the browser picks its own colours
const isText = (e: ViewerFile) => !!e.contentType && (e.contentType.startsWith('text/') || /json|xml|yaml/.test(e.contentType))
// Evidence is untrusted: an iframe would run HTML in the app's origin, so only
// a PDF goes in one. Anything else that isn't shown above is a download.
const isPdf = (e: ViewerFile) => !!e.contentType?.startsWith('application/pdf')
const text = ref<string | null>(null)
const textError = ref<string | null>(null)
watch(open, async (item) => {
  text.value = null
  textError.value = null
  if (!item?.url || !isText(item)) return
  try {
    const res = await fetch(item.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (open.value?.id === item.id) text.value = await res.text()
  } catch (e) {
    if (open.value?.id === item.id) textError.value = `Couldn't load the file: ${e instanceof Error ? e.message : String(e)}`
  }
})
</script>

<template>
  <UModal
    :open="open !== null"
    :title="open?.fileName ?? undefined"
    :description="open ? `${open.kind.replace('_', ' ')} · ${timeAgo(open.createdAt)}${open.note ? ` · ${open.note}` : ''}` : ''"
    :ui="{ content: 'max-w-4xl' }"
    @update:open="open = null"
  >
    <template #body>
      <img
        v-if="open && isImage(open)"
        :src="open.url ?? undefined"
        :alt="open.note || open.fileName || undefined"
        class="max-h-[70vh] w-full object-contain"
      >
      <template v-else-if="open && isVideo(open)">
        <video
          :src="open.url ?? undefined"
          controls
          playsinline
          class="max-h-[70vh] w-full"
        />
        <a
          :href="open.url ?? undefined"
          :download="open.fileName ?? ''"
          class="mt-2 inline-block text-sm text-primary hover:underline"
        >Download</a>
      </template>
      <template v-else-if="open && isText(open)">
        <UAlert
          v-if="textError"
          color="error"
          variant="subtle"
          :title="textError"
        />
        <USkeleton
          v-else-if="text === null"
          class="h-40 w-full"
        />
        <pre
          v-else
          class="max-h-[60vh] overflow-auto overscroll-contain rounded-md border border-default bg-muted p-3 font-mono text-xs/5 whitespace-pre-wrap text-default"
        >{{ text }}</pre>
      </template>
      <iframe
        v-else-if="open && isPdf(open)"
        :src="open.url ?? undefined"
        :title="open.fileName ?? undefined"
        class="h-[60vh] w-full rounded-md border border-default"
      />
      <p
        v-else-if="open"
        class="text-sm text-muted"
      >
        This file can't be previewed.
        <a
          :href="open.url ?? undefined"
          :download="open.fileName ?? ''"
          class="text-primary hover:underline"
        >Download</a>
      </p>
    </template>
  </UModal>
</template>
