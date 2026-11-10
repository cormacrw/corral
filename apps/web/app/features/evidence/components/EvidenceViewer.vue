<script setup lang="ts">
import { errorText } from '@corral/core'
import type { Evidence } from '@corral/contracts'
import { computed, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { usePinchZoom } from '~/features/evidence/composables/usePinchZoom'
import { isImage, isPdf, isText, isVideo, kindLabel } from '~/features/evidence/utils/evidenceFile'
import { timeAgo } from '~/utils/labels'

export type ViewerFile = Pick<Evidence, 'id' | 'fileName' | 'kind' | 'createdAt' | 'note' | 'url' | 'contentType'>
const open = defineModel<ViewerFile | null>({ required: true })
// The files to flip through from the open one, with arrows, the arrow keys
// or a swipe. Without it, or when the open file isn't in it, there's one file.
// `captions`, by file ID, name what each file proves (its criterion): given
// one, it's the footer under the file, in place of the file name up top.
const props = defineProps<{ files?: ViewerFile[], captions?: Record<string, string> }>()
const caption = computed(() => open.value ? props.captions?.[open.value.id] ?? null : null)
const details = computed(() => open.value ? `${kindLabel(open.value.kind)} · ${timeAgo(open.value.createdAt)}${open.value.note ? ` · ${open.value.note}` : ''}` : '')
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
// Swipe to the next file; pinch to zoom an image, which starts unzoomed each time
const frame = ref<HTMLElement | null>(null)
const pinch = usePinchZoom(frame, step, () => Boolean(open.value && isImage(open.value)))
watch(() => open.value?.id, pinch.reset)
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
    if (open.value?.id === item.id) textError.value = `Couldn't load the file: ${errorText(e)}`
  }
})
</script>

<template>
  <AppModal
    :open="open !== null"
    :title="open?.fileName ?? undefined"
    :description="details"
    :hide-header="caption !== null"
    content-class="sm:max-w-4xl"
    @update:open="open = null"
  >
    <template #body>
      <div
        ref="frame"
        :class="['min-w-0', open && isImage(open) && 'touch-none overflow-hidden']"
        data-testid="evidence-viewer-body"
      >
        <img
          v-if="open && isImage(open)"
          :src="open.url ?? undefined"
          :alt="open.note || open.fileName || undefined"
          loading="lazy"
          draggable="false"
          :style="pinch.style.value"
          :class="['h-[70vh] w-full object-contain select-none', !pinch.zoomed.value && 'transition-transform duration-150']"
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
        v-if="caption"
        class="-mt-2 border-t border-border pt-3 text-sm"
        data-testid="evidence-viewer-caption"
      >
        <p class="font-medium text-foreground">
          {{ caption }}
        </p>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {{ details }}
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
