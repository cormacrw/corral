<script setup lang="ts">
import { VisAxis, VisStackedBar, VisXYContainer } from '@unovis/vue'
import type { ChartConfig } from '~/components/ui/chart'
import { ChartContainer, ChartCrosshair, ChartTooltip, ChartTooltipContent, componentToString } from '~/components/ui/chart'
import type { OutcomeDay } from '~/features/agents/utils/fleet'
import { END_TONES, RUN_TONE } from '~/features/agents/utils/fleet'

// One agent's finished runs per day, stacked by how they ended, in the run
// timeline's colours (design/agent.md, Activity)
const props = withDefaults(defineProps<{ days: OutcomeDay[], height?: number }>(), { height: 200 })

const tones = END_TONES.map(tone => ({ tone, ...RUN_TONE[tone] }))
const config = Object.fromEntries(tones.map(t => [t.tone, { label: t.label, color: t.color }])) satisfies ChartConfig
const data = computed(() => props.days.map(d => ({ index: d.index, ...d.byTone })))
type Row = typeof data.value[number]
const y = tones.map(t => (d: Row) => d[t.tone])
const color = (_: Row, i: number) => tones[i]!.color
const label = (x: number | Date) => props.days[Math.round(Number(x))]?.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) ?? ''
const tooltip = componentToString(config, ChartTooltipContent, { labelFormatter: label })
const empty = computed(() => props.days.every(d => d.total === 0))
</script>

<template>
  <div class="flex flex-col gap-3">
    <p
      v-if="empty"
      class="flex items-center justify-center text-sm text-muted-foreground"
      :style="{ height: `${height}px` }"
    >
      No finished runs in the last {{ days.length }} days.
    </p>
    <ChartContainer
      v-else
      :config="config"
      class="aspect-auto"
      :style="{ height: `${height}px` }"
    >
      <VisXYContainer
        :data="data"
        :margin="{ right: 4 }"
        :padding="{ top: 8 }"
      >
        <VisStackedBar
          :x="(d: Row) => d.index"
          :y="y"
          :color="color"
          :rounded-corners="3"
          :bar-padding="0.25"
        />
        <VisAxis
          type="x"
          :tick-format="label"
          :num-ticks="5"
          :grid-line="false"
          :domain-line="false"
          :tick-line="false"
        />
        <VisAxis
          type="y"
          :num-ticks="3"
          :tick-format="(v: number) => Number.isInteger(v) ? String(v) : ''"
          :domain-line="false"
          :tick-line="false"
        />
        <ChartTooltip />
        <ChartCrosshair
          :template="tooltip"
          color="#0000"
        />
      </VisXYContainer>
    </ChartContainer>
    <ChartLegend :items="tones.map(t => ({ label: t.label, color: t.color }))" />
  </div>
</template>
