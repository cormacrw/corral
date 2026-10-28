<script setup lang="ts">
// The docked flyout wrapper: resizable 360–960px, remembered width. Shows a
// task or an epic.
const flyout = useTaskFlyout()
const width = useLocalStorage('corral.flyout.width', 420)
const dragging = ref(false)
let startX = 0
let startWidth = 0

function onPointerDown(event: PointerEvent) {
  dragging.value = true
  startX = event.clientX
  startWidth = width.value
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
}
function onPointerMove(event: PointerEvent) {
  if (!dragging.value) return
  width.value = Math.min(960, Math.max(360, startWidth - (event.clientX - startX)))
}
function onPointerUp() {
  dragging.value = false
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') width.value = Math.min(960, width.value + 16)
  if (event.key === 'ArrowRight') width.value = Math.max(360, width.value - 16)
}
</script>

<template>
  <aside
    v-if="flyout.ref.value || flyout.epic.value"
    role="complementary"
    :aria-label="flyout.ref.value ? `Task ${flyout.ref.value}` : 'Epic'"
    class="relative flex h-full shrink-0 flex-col border-s border-default bg-default max-[1100px]:w-full max-[1100px]:border-s-0 max-[1100px]:border-t"
    :style="{ width: `${width}px` }"
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
    <TaskDetail
      v-if="flyout.ref.value"
      :task-ref="flyout.ref.value"
      mode="flyout"
      @close="flyout.close()"
    />
    <EpicDetail
      v-else-if="flyout.epic.value"
      :epic-id="flyout.epic.value"
      mode="flyout"
      @close="flyout.close()"
    />
  </aside>
</template>
