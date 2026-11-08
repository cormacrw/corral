<script setup lang="ts">
import { computed, ref, useTemplateRef, watchEffect } from 'vue'

// The working indicator for cards: a glowing mesh-gradient edge that sweeps
// round the wrapped element without stopping. Adapted from Vue Bits'
// BorderGlow (https://vue-bits.dev) with the pointer tracking removed: the
// cone is driven by the `glow-spin` animation in main.css, and the layers sit
// over the slot so the wrapped card keeps its own border and background.
// Reduced motion stops the sweep and leaves the glow where it is. The wrapper
// is a flex column so the wrapped element stretches to its full width, as it
// would without the glow (a button otherwise shrinks to fit its content).
const props = withDefaults(defineProps<{
  active?: boolean
  // Match the wrapped element's corner radius (rounded-md is 6, rounded-lg 8)
  borderRadius?: number
  glowRadius?: number
  // Seconds per lap
  duration?: number
}>(), {
  active: true,
  borderRadius: 6,
  glowRadius: 24,
  duration: 4
})
// The glow's hue (H S L), the edge's mesh colours, and the edge cone's width
// as a percentage
const GLOW_COLOR = '172 66% 50%'
const COLORS = ['#6ee7b7', '#34d399', '#38bdf8']
const GLOW_INTENSITY = 0.6
const CONE_SPREAD = 25
const FILL_OPACITY = 0.5

// Keep SSR and the first client render identical; choose a phase per mount.
const lapOffset = ref(0)
onMounted(() => {
  lapOffset.value = Math.random()
})
const animationDelay = computed(() => `${-lapOffset.value * props.duration}s`)

function parseHSL(hslStr: string): { h: number, s: number, l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/)
  if (!match) return { h: 172, s: 66, l: 50 }
  return { h: parseFloat(match[1]!), s: parseFloat(match[2]!), l: parseFloat(match[3]!) }
}

function buildBoxShadow(glowColor: string, intensity: number): string {
  const { h, s, l } = parseHSL(glowColor)
  const base = `${h}deg ${s}% ${l}%`
  const layers: [number, number, number, boolean][] = [
    [0, 1, 100, true],
    [1, 0, 60, true],
    [3, 0, 50, true],
    [6, 0, 40, true],
    [15, 0, 30, true],
    [25, 2, 20, true],
    [50, 2, 10, true],
    [1, 0, 60, false],
    [3, 0, 50, false],
    [6, 0, 40, false],
    [15, 0, 30, false],
    [25, 2, 20, false],
    [50, 2, 10, false]
  ]
  return layers
    .map(([blur, spread, alpha, inset]) =>
      `${inset ? 'inset ' : ''}0 0 ${blur}px ${spread}px hsl(${base} / ${Math.min(alpha * intensity, 100)}%)`)
    .join(', ')
}

const GRADIENT_POSITIONS = ['80% 55%', '69% 34%', '8% 6%', '41% 38%', '86% 85%', '82% 18%', '51% 4%']
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1]

function buildMeshGradients(colors: string[]): string[] {
  const gradients = GRADIENT_POSITIONS.map((position, i) =>
    `radial-gradient(at ${position}, ${colors[Math.min(COLOR_MAP[i]!, colors.length - 1)]} 0px, transparent 50%)`)
  gradients.push(`linear-gradient(${colors[0]} 0 100%)`)
  return gradients
}

// The sweep repaints every frame on the main thread, so it stops off-screen
const root = useTemplateRef<HTMLElement>('root')
const onScreen = ref(true)
watchEffect((onCleanup) => {
  if (!root.value || typeof IntersectionObserver === 'undefined') return
  const observer = new IntersectionObserver(([entry]) => {
    onScreen.value = entry!.isIntersecting
  }, { rootMargin: `${props.glowRadius}px` })
  observer.observe(root.value)
  onCleanup(() => observer.disconnect())
})

const mesh = buildMeshGradients(COLORS)
const boxShadow = buildBoxShadow(GLOW_COLOR, GLOW_INTENSITY)
const edgeCone = `conic-gradient(from var(--glow-angle) at center, black ${CONE_SPREAD}%, transparent ${CONE_SPREAD + 15}%, transparent ${100 - CONE_SPREAD - 15}%, black ${100 - CONE_SPREAD}%)`
const fillMask = [
  'linear-gradient(to bottom, black, black)',
  'radial-gradient(ellipse at 50% 50%, black 40%, transparent 65%)',
  'radial-gradient(ellipse at 66% 66%, black 5%, transparent 40%)',
  'radial-gradient(ellipse at 33% 33%, black 5%, transparent 40%)',
  'radial-gradient(ellipse at 66% 33%, black 5%, transparent 40%)',
  'radial-gradient(ellipse at 33% 66%, black 5%, transparent 40%)',
  'conic-gradient(from var(--glow-angle) at center, transparent 5%, black 15%, black 85%, transparent 95%)'
].join(', ')
const glowCone = 'conic-gradient(from var(--glow-angle) at center, black 2.5%, transparent 10%, transparent 90%, black 97.5%)'
</script>

<template>
  <div
    v-if="props.active"
    ref="root"
    class="relative isolate flex flex-col motion-safe:animate-glow-spin"
    :style="{ borderRadius: `${props.borderRadius}px`, animationDuration: `${props.duration}s`, animationDelay, animationPlayState: onScreen ? undefined : 'paused' }"
  >
    <slot />

    <!-- mesh gradient edge: the cone picks the arc, the inner span cuts it to a 1px ring -->
    <span
      class="pointer-events-none absolute inset-0 z-[1] rounded-[inherit]"
      :style="{ maskImage: edgeCone }"
      aria-hidden="true"
    >
      <span
        class="absolute inset-0 rounded-[inherit] border border-transparent"
        :style="{
          background: mesh.map(g => `${g} border-box`).join(', '),
          maskImage: 'linear-gradient(#000 0 0), linear-gradient(#000 0 0)',
          maskClip: 'padding-box, border-box',
          maskComposite: 'exclude'
        }"
      />
    </span>

    <span
      class="pointer-events-none absolute inset-0 z-[1] rounded-[inherit] border border-transparent mix-blend-soft-light"
      :style="{
        background: mesh.map(g => `${g} padding-box`).join(', '),
        maskImage: fillMask,
        maskComposite: 'subtract, add, add, add, add, add',
        opacity: FILL_OPACITY
      }"
      aria-hidden="true"
    />

    <span
      class="pointer-events-none absolute z-[1] rounded-[inherit] mix-blend-normal dark:mix-blend-plus-lighter"
      :style="{ inset: `-${props.glowRadius}px`, maskImage: glowCone }"
      aria-hidden="true"
    >
      <span
        class="absolute rounded-[inherit]"
        :style="{ inset: `${props.glowRadius}px`, boxShadow }"
      />
    </span>
  </div>
  <slot v-else />
</template>
