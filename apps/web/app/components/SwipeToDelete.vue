<script setup lang="ts">
// A list row that swipes left to reveal a red Delete button. A full swipe
// deletes straight away; a short one snaps back (design/inbox.md#mobile).
const emit = defineEmits<{ delete: [] }>()
const REVEAL = 88
const offset = ref(0)
const dragging = ref(false)
const row = ref<HTMLElement | null>(null)
const action = ref<HTMLElement | null>(null)
let start: { x: number, y: number, offset: number, pointer: number } | null = null
let horizontal: boolean | null = null
// A drag ends with a click on the row, which mustn't open it
let swiped = false

function down(e: PointerEvent) {
  if (e.button !== 0) return
  start = { x: e.clientX, y: e.clientY, offset: offset.value, pointer: e.pointerId }
  horizontal = null
  swiped = false
}
function move(e: PointerEvent) {
  if (!start || e.pointerId !== start.pointer) return
  const dx = e.clientX - start.x
  const dy = e.clientY - start.y
  if (horizontal === null) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
    horizontal = Math.abs(dx) > Math.abs(dy)
    // Scrolling the list
    if (!horizontal) {
      start = null
      return
    }
    dragging.value = true
    swiped = true
    row.value?.setPointerCapture?.(e.pointerId)
  }
  offset.value = Math.min(0, Math.max(start.offset + dx, -(row.value?.offsetWidth ?? 0)))
}
function up() {
  if (!start) return
  start = null
  dragging.value = false
  if (!horizontal) return
  const width = row.value?.offsetWidth ?? 0
  if (width > 0 && -offset.value > width * 0.6) {
    offset.value = -width
    emit('delete')
  } else {
    offset.value = -offset.value > REVEAL / 2 ? -REVEAL : 0
  }
}
function cancel() {
  if (!start) return
  start = null
  dragging.value = false
  if (horizontal) offset.value = 0
}
// Tapping a revealed row closes it instead of opening it
function click(e: MouseEvent) {
  if (!swiped && action.value?.contains(e.target as Node)) return
  if (swiped || offset.value !== 0) {
    e.preventDefault()
    e.stopPropagation()
    if (!swiped) offset.value = 0
  }
  swiped = false
}
</script>

<template>
  <div
    ref="row"
    class="relative touch-pan-y overflow-hidden"
    data-testid="swipe-row"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="cancel"
    @click.capture="click"
  >
    <div
      class="absolute inset-0 flex justify-end bg-error"
      :class="offset === 0 && 'invisible'"
    >
      <button
        ref="action"
        type="button"
        class="flex items-center justify-center gap-1 text-sm font-semibold text-inverted"
        :style="{ width: `${REVEAL}px` }"
        :tabindex="offset === 0 ? -1 : 0"
        @click="emit('delete')"
        @pointerdown.stop="swiped = false"
      >
        <UIcon
          name="i-lucide-trash-2"
          class="size-4"
        />
        Delete
      </button>
    </div>
    <div
      class="relative bg-default"
      :class="!dragging && 'transition-transform duration-200'"
      :style="{ transform: `translateX(${offset}px)` }"
    >
      <slot />
    </div>
  </div>
</template>
