<script setup lang="ts">
import type { Evidence } from '@corral/contracts'
import { ref, watch } from 'vue'
import AppCarousel from '~/components/app/AppCarousel.vue'

// Screenshots one at a time, large, each opening in the viewer. `current` is
// the file open in the viewer: flipping there moves the carousel along, so it
// shows the last one viewed on closing.
const props = defineProps<{ shots: { evidence: Evidence, caption: string | null }[], current?: string | null }>()
defineEmits<{ open: [evidence: Evidence] }>()
const carousel = ref<{ scrollTo: (i: number, smooth?: boolean) => void, focusSlide: (i: number) => void } | null>(null)
// The slide the viewer closed on. Closing gives focus back to the slide that
// opened it, which would scroll back there, so focus moves on to this one.
// The dialog gives focus back once it has animated out.
let closedOn = -1
watch(() => props.current, (id, previous) => {
  const i = props.shots.findIndex(s => s.evidence.id === id)
  if (i !== -1) carousel.value?.scrollTo(i, false)
  if (!id && previous) {
    closedOn = props.shots.findIndex(s => s.evidence.id === previous)
    // Focus may go back to a file outside the carousel instead
    setTimeout(() => closedOn = -1, 1000)
  }
})
function onFocusin(event: FocusEvent) {
  const i = closedOn
  closedOn = -1
  if (i === -1 || (event.currentTarget as HTMLElement).children[i] === event.target) return
  carousel.value?.focusSlide(i)
}
</script>

<template>
  <AppCarousel
    ref="carousel"
    label="Screenshots"
    @focusin="onFocusin"
  >
    <button
      v-for="{ evidence, caption } in shots"
      :key="evidence.id"
      type="button"
      class="w-full min-w-0 shrink-0 snap-start overflow-hidden rounded-md border border-border text-start hover:border-input focus-visible:border-primary focus-visible:outline-none"
      :aria-label="`Open ${evidence.fileName}`"
      @click="$emit('open', evidence)"
    >
      <img
        :src="evidence.url ?? undefined"
        :alt="evidence.note || evidence.fileName || ''"
        class="aspect-video w-full bg-muted/50 object-contain"
      >
      <span
        class="block border-t border-border px-3 py-2 text-xs text-muted-foreground"
        :title="caption ?? undefined"
      ><span class="line-clamp-2">{{ caption }}</span></span>
    </button>
  </AppCarousel>
</template>
