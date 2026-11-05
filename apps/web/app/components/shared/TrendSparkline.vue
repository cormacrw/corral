<script setup lang="ts">
import { VisArea, VisLine, VisXYContainer } from '@unovis/vue'
import { CurveType } from '@unovis/ts'

// A bare trend line: no axes, no tooltip. The number beside it carries the value.
const props = withDefaults(defineProps<{ values: number[], color?: string, height?: number, fill?: boolean }>(), { color: 'var(--brand)', height: 32, fill: true })
const data = computed(() => props.values.map((y, x) => ({ x, y })))
const x = (d: { x: number }) => d.x
const y = (d: { y: number }) => d.y
</script>

<template>
  <div class="min-w-0">
    <VisXYContainer
      :data="data"
      :height="height"
      :margin="{ top: 2, bottom: 2 }"
      :y-domain="[0, undefined]"
    >
      <VisArea
        v-if="fill"
        :x="x"
        :y="y"
        :color="color"
        :opacity="0.15"
        :curve-type="CurveType.MonotoneX"
      />
      <VisLine
        :x="x"
        :y="y"
        :color="color"
        :line-width="2"
        :curve-type="CurveType.MonotoneX"
      />
    </VisXYContainer>
  </div>
</template>
