<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
import type { Evidence } from '@corral/contracts'
import { computed, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { isImage, isPdf, isText, isVideo, kindLabel } from '~/features/evidence/utils/evidenceFile'
import { timeAgo } from '~/utils/labels'

export type ViewerFile = Pick<Evidence, 'id' | 'fileName' | 'kind' | 'createdAt' | 'note' | 'url' | 'contentType'>
const open = defineModel<ViewerFile | null>({ required: true })
// The files to flip through from the open one, with arrows, the arrow keys
// or a swipe. Without it, or when the open file isn't in it, there's one file.
const props = defineProps<{ files?: ViewerFile[] }>()
const index = computed(() => open.value ? (props.files ?? []).findIndex(f => f.id === open.value!.id) : -1)
const paging = computed(() => index.value !== -1 && props.files!.length > 1)
function step(by: -1 | 1) {
  if (!paging.value) return
  const files = props.files!
  open.value = files[(index.value + by + files.length) % files.length]!
}
useEventListener('keydown', (event: KeyboardEvent) => {
  if (!paging.value || event.defaultPrevented || (event.target instanceof Element && event.target.closest('input, textarea, select, video, [contenteditable]'))) return
  if (event.key === 'ArrowLeft') step(-1)
  else if (event.key === 'ArrowRight') step(1)
  else return
  event.preventDefault()
})
// A sideways swipe of 50px or more that's more sideways than down
let touch: { x: number, y: number } | null = null
function touchStart(event: TouchEvent) {
  const t = event.touches[0]
  touch = event.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null
}
function touchEnd(event: TouchEvent) {
  const t = event.changedTouches[0]
  if (!touch || !t) return
  const dx = t.clientX - touch.x
  const dy = t.clientY - touch.y
  touch = null
  if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1)
}
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
    content-class="sm:max-w-4xl"
    @update:open="open = null"
  >
    <template #body>
      <div
        class="min-w-0"
        data-testid="evidence-viewer-body"
        @touchstart.passive="touchStart"
        @touchend="touchEnd"
      >
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
      </div>
      <div
        v-if="paging"
        class="flex items-center justify-between gap-2"
      >
        <AppButton
          icon="i-hugeicons-arrow-left-01"
          aria-label="Previous file"
          color="neutral"
          variant="outline"
          class="tap-target"
          @click="step(-1)"
        />
        <span
          class="text-sm text-muted-foreground tabular-nums"
          aria-live="polite"
        >{{ index + 1 }} of {{ files!.length }}</span>
        <AppButton
          icon="i-hugeicons-arrow-right-01"
          aria-label="Next file"
          color="neutral"
          variant="outline"
          class="tap-target"
          @click="step(1)"
        />
      </div>
    </template>
  </AppModal>
</template>
