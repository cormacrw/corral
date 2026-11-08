<script setup lang="ts">
import type { Project } from '@corral/contracts'
import { VisAxis, VisStackedBar, VisXYContainer } from '@unovis/vue'
import type { ChartConfig } from '~/components/ui/chart'
import { ChartContainer, ChartCrosshair, ChartTooltip, ChartTooltipContent, componentToString } from '~/components/ui/chart'
import type { MergedDay } from '~/features/home/utils/figures'

// Tasks merged per day, stacked by project, in each project's own colour
const props = withDefaults(defineProps<{ rows: MergedDay[], projects: (Project & { color: string })[], height?: number }>(), { height: 220 })

// Keys are positional: a project ID isn't a safe CSS variable name
const config = computed(() => Object.fromEntries(props.projects.map((p, i) => [`p${i}`, { label: p.name, color: p.color }])) satisfies ChartConfig)
const data = computed(() => props.rows.map(r => ({ index: r.index, date: r.date, ...Object.fromEntries(props.projects.map((p, i) => [`p${i}`, r.byProject[p.id] ?? 0])) })))
type Row = { index: number, date: Date } & Record<string, number>
const y = computed(() => props.projects.map((_, i) => (d: Row) => d[`p${i}`] ?? 0))
const color = (_: Row, i: number) => props.projects[i]?.color ?? 'var(--muted-foreground)'
const label = (x: number | Date) => props.rows[Math.round(Number(x))]?.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) ?? ''
// Built once at setup (it registers an ID), over an object kept in step with
// the projects, so a renamed or added project shows in the tooltip
const tooltipConfig: ChartConfig = {}
watchEffect(() => Object.assign(tooltipConfig, config.value))
const tooltip = componentToString(tooltipConfig, ChartTooltipContent, { labelFormatter: label })
const empty = computed(() => props.rows.every(r => r.total === 0))
</script>

<template>
  <div class="flex flex-col gap-3">
    <p
      v-if="empty"
      class="flex items-center justify-center text-sm text-muted-foreground"
      :style="{ height: `${height}px` }"
    >
      Nothing merged in the last 30 days.
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
          :num-ticks="6"
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
    <ChartLegend
      v-if="projects.length > 1"
      :items="projects.map(p => ({ label: p.name, color: p.color }))"
    />
  </div>
</template>
