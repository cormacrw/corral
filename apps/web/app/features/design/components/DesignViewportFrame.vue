<script lang="ts">
// The prototype renders at the viewport's real size and is scaled down to
// fit, so a desktop layout stays a desktop layout on a narrow screen
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } } as const
export type DesignViewport = keyof typeof VIEWPORTS
</script>

<script setup lang="ts">
const props = defineProps<{ viewport: DesignViewport }>()
const frame = useTemplateRef<HTMLElement>('frame')
const available = ref(0)
let observer: ResizeObserver | null = null
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    available.value = entry?.contentRect.width ?? 0
  })
  if (frame.value) observer.observe(frame.value)
})
onBeforeUnmount(() => observer?.disconnect())
const size = computed(() => VIEWPORTS[props.viewport])
const scale = computed(() => available.value > 0 ? Math.min(1, available.value / size.value.width) : 1)
</script>

<template>
  <div
    ref="frame"
    class="w-full"
  >
    <div
      class="mx-auto overflow-hidden rounded-lg border border-border bg-white shadow-xs"
      :style="{ width: `${size.width * scale}px`, height: `${size.height * scale}px` }"
      :data-viewport="viewport"
    >
      <div
        class="origin-top-left"
        :style="{ width: `${size.width}px`, height: `${size.height}px`, transform: `scale(${scale})` }"
      >
        <slot />
      </div>
    </div>
  </div>
</template>
