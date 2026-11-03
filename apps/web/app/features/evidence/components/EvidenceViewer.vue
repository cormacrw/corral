<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
import type { Evidence } from '@corral/contracts'
import { ref, watch } from 'vue'
import { isImage, isPdf, isText, isVideo, kindLabel } from '~/features/evidence/utils/evidenceFile'
import { timeAgo } from '~/utils/labels'

export type ViewerFile = Pick<Evidence, 'id' | 'fileName' | 'kind' | 'createdAt' | 'note' | 'url' | 'contentType'>
const open = defineModel<ViewerFile | null>({ required: true })
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
    if (open.value?.id === item.id) textError.value = `Couldn't load the file: ${errorMessage(e)}`
  }
})
</script>

<template>
  <AppModal
    :open="open !== null"
    :title="open?.fileName ?? undefined"
    :description="open ? `${kindLabel(open.kind)} · ${timeAgo(open.createdAt)}${open.note ? ` · ${open.note}` : ''}` : ''"
    content-class="max-w-4xl"
    @update:open="open = null"
  >
    <template #body>
      <img
        v-if="open && isImage(open)"
        :src="open.url ?? undefined"
        :alt="open.note || open.fileName || undefined"
        loading="lazy"
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
          class="mt-2 inline-block text-sm text-brand hover:underline"
        >Download</a>
      </template>
      <template v-else-if="open && isText(open)">
        <AppLoadError
          v-if="textError"
          :title="textError"
        />
        <UiSkeleton
          v-else-if="text === null"
          class="h-40 w-full"
        />
        <pre
          v-else
          class="max-h-[60vh] overflow-auto overscroll-contain rounded-md border border-border bg-muted/50 p-3 font-mono text-xs/5 whitespace-pre-wrap text-foreground"
        >{{ text }}</pre>
      </template>
      <iframe
        v-else-if="open && isPdf(open)"
        :src="open.url ?? undefined"
        :title="open.fileName ?? undefined"
        class="h-[60vh] w-full rounded-md border border-border"
      />
      <p
        v-else-if="open"
        class="text-sm text-muted-foreground"
      >
        This file can't be previewed.
        <a
          :href="open.url ?? undefined"
          :download="open.fileName ?? ''"
          class="text-brand hover:underline"
        >Download</a>
      </p>
    </template>
  </AppModal>
</template>
