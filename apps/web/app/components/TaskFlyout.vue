<script setup lang="ts">
// The docked flyout wrapper: resizable 360–960px, remembered width. Shows a
// task, an epic, or what the page puts in its slot for ?plan.
const flyout = useTaskFlyout()
const saved = useLocalStorage('corral.flyout.width', 420)
// Follows the pointer while dragging; saved when it lets go
const width = ref(saved.value)
const dragging = ref(false)
let startX = 0
let startWidth = 0

function onPointerDown(event: PointerEvent) {
  dragging.value = true
  startX = event.clientX
  // What's on screen: the width can be held down by the room available
  startWidth = (event.target as HTMLElement).parentElement?.offsetWidth ?? width.value
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
}
function onPointerMove(event: PointerEvent) {
  if (!dragging.value) return
  width.value = Math.min(960, Math.max(360, startWidth - (event.clientX - startX)))
}
function onPointerUp() {
  dragging.value = false
  saved.value = width.value
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') width.value = Math.min(960, width.value + 16)
  if (event.key === 'ArrowRight') width.value = Math.max(360, width.value - 16)
  saved.value = width.value
}
</script>

<template>
  <aside
    v-if="flyout.ref.value || flyout.epic.value || (flyout.plan.value && $slots.plan)"
    role="complementary"
    :aria-label="flyout.ref.value ? `Task ${flyout.ref.value}` : flyout.epic.value ? 'Epic' : 'Plan'"
    class="relative flex h-full max-w-[calc(100%-20rem)] shrink-0 flex-col border-s border-default bg-default max-[1100px]:h-1/2 max-[1100px]:w-full max-[1100px]:max-w-full max-[1100px]:border-s-0 max-[1100px]:border-t min-[1101px]:w-(--flyout-width)"
    :style="{ '--flyout-width': `${width}px` }"
  >
    <div
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-valuenow="width"
      aria-valuemin="360"
      aria-valuemax="960"
      :class="['absolute inset-y-0 -start-0.5 z-10 w-1 cursor-col-resize hover:bg-primary focus:bg-primary max-[1100px]:hidden', dragging && 'bg-primary']"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @keydown="onKey"
    />
    <AsyncTaskDetail
      v-if="flyout.ref.value"
      :task-ref="flyout.ref.value"
      mode="flyout"
      @close="flyout.close()"
    />
    <AsyncEpicDetail
      v-else-if="flyout.epic.value"
      :epic-id="flyout.epic.value"
      mode="flyout"
      @close="flyout.close()"
    />
    <slot
      v-else
      name="plan"
    />
  </aside>
</template>
