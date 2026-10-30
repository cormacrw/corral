<script setup lang="ts">
import type { Evidence } from '@corral/contracts'
import { ref, watch } from 'vue'
import { timeAgo } from '~/utils/labels'

// The evidence viewer: an image, video, text file or page in a modal
const props = defineProps<{ item: Evidence | null }>()
const emit = defineEmits<{ close: [] }>()
const isImage = (e: Evidence) => !!e.contentType?.startsWith('image/')
const isVideo = (e: Evidence) => !!e.contentType?.startsWith('video/')
// Logs, test output and requests: shown as text in the app's theme, not in
// an iframe where the browser picks its own colours
const isText = (e: Evidence) => !!e.contentType && (e.contentType.startsWith('text/') || /json|xml|yaml/.test(e.contentType))
const text = ref<string | null>(null)
const textError = ref<string | null>(null)
watch(() => props.item, async (item) => {
  text.value = null
  textError.value = null
  if (!item?.url || !isText(item)) return
  try {
    const res = await fetch(item.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (props.item?.id === item.id) text.value = await res.text()
  } catch (e) {
    if (props.item?.id === item.id) textError.value = `Couldn't load the file: ${e instanceof Error ? e.message : String(e)}`
  }
})
</script>

<template>
  <UModal
    :open="item !== null"
    :title="item?.fileName ?? undefined"
    :description="item ? `${item.kind.replace('_', ' ')} · ${timeAgo(item.createdAt)}${item.note ? ` · ${item.note}` : ''}` : ''"
    :ui="{ content: 'max-w-4xl' }"
    @update:open="emit('close')"
  >
    <template #body>
      <img
        v-if="item && isImage(item)"
        :src="item.url ?? undefined"
        :alt="item.note || item.fileName || undefined"
        class="max-h-[70vh] w-full object-contain"
      >
      <video
        v-else-if="item && isVideo(item)"
        :src="item.url ?? undefined"
        controls
        class="max-h-[70vh] w-full"
      />
      <template v-else-if="item && isText(item)">
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
        v-else-if="item"
        :src="item.url ?? undefined"
        :title="item.fileName ?? undefined"
        class="h-[60vh] w-full rounded-md border border-default"
      />
    </template>
  </UModal>
</template>
