<script setup lang="ts">
import { onMounted, onUpdated, ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'

// One full-width slide at a time, scrolling sideways with a snap: swipe on a
// phone, or the arrows, with "n of m" while there's more than one. Give each
// slide `w-full shrink-0 snap-start`. Slides can hold buttons: tabbing to one
// scrolls it into view.
defineProps<{ label: string }>()
defineEmits<{ focusin: [event: FocusEvent] }>()
const track = ref<HTMLElement | null>(null)
const index = ref(0)
const count = ref(0)

function measure() {
  const el = track.value
  if (!el) return
  count.value = el.children.length
  index.value = el.clientWidth ? Math.min(Math.round(el.scrollLeft / el.clientWidth), Math.max(count.value - 1, 0)) : 0
}
function scrollTo(i: number, smooth = true) {
  const el = track.value
  if (!el) return
  el.scrollTo({ left: i * el.clientWidth, behavior: smooth ? undefined : 'instant' })
  // An instant jump can land without a scroll event, as behind an open dialog
  if (!smooth) measure()
}
// Moves focus to a slide, and the carousel to it with no animation
function focusSlide(i: number) {
  const slide = track.value?.children[i]
  if (!(slide instanceof HTMLElement)) return
  slide.focus({ preventScroll: true })
  scrollTo(i, false)
}
onMounted(measure)
onUpdated(measure)
useResizeObserver(track, measure)
defineExpose({ scrollTo, focusSlide })
</script>

<template>
  <div
    role="group"
    aria-roledescription="carousel"
    :aria-label="label"
    class="relative min-w-0"
  >
    <div
      ref="track"
      data-carousel-track
      class="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] motion-safe:scroll-smooth"
      @scroll.passive="measure"
      @focusin="$emit('focusin', $event)"
    >
      <slot />
    </div>
    <template v-if="count > 1">
      <AppButton
        v-if="index > 0"
        icon="i-hugeicons-arrow-left-01"
        aria-label="Previous"
        color="neutral"
        variant="outline"
        class="tap-target absolute start-2 top-1/2 -translate-y-1/2 rounded-full bg-background/90"
        @click="scrollTo(index - 1)"
      />
      <AppButton
        v-if="index < count - 1"
        icon="i-hugeicons-arrow-right-01"
        aria-label="Next"
        color="neutral"
        variant="outline"
        class="tap-target absolute end-2 top-1/2 -translate-y-1/2 rounded-full bg-background/90"
        @click="scrollTo(index + 1)"
      />
      <span
        class="pointer-events-none absolute end-2 top-2 rounded-full bg-background/90 px-2 py-0.5 text-xs text-muted-foreground tabular-nums"
        aria-live="polite"
        data-testid="carousel-position"
      >{{ index + 1 }} of {{ count }}</span>
    </template>
  </div>
</template>
