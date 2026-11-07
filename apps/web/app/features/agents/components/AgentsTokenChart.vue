<script setup lang="ts">
import { CurveType } from '@unovis/ts'
import { VisArea, VisAxis, VisXYContainer } from '@unovis/vue'
import type { ChartConfig } from '~/components/ui/chart'
import { ChartContainer, ChartCrosshair, ChartTooltip, ChartTooltipContent, componentToString } from '~/components/ui/chart'
import type { TokenDay } from '~/features/agents/utils/fleet'
import { formatTokens, TOKEN_ROLES } from '~/features/agents/utils/fleet'
import type { AgentRole } from '@corral/core'
import { ROLE } from '~/utils/labels'

// Tokens per day (input, cache writes and output), stacked by role. An
// agent's page passes `only` its own role, which keeps that role's colour.
const props = withDefaults(defineProps<{ days: TokenDay[], height?: number, only?: AgentRole }>(), { height: 220, only: undefined })

const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)']
const roles = TOKEN_ROLES.map((role, i) => ({ role, label: ROLE[role], color: COLORS[i]! })).filter(r => !props.only || r.role === props.only)
const config = Object.fromEntries(roles.map(r => [r.role, { label: r.label, color: r.color }])) satisfies ChartConfig
const data = computed(() => props.days.map(d => ({ index: d.index, ...d.byRole })))
type Row = typeof data.value[number]
const y = roles.map(r => (d: Row) => d[r.role])
const color = (_: Row, i: number) => roles[i]!.color
const label = (x: number | Date) => props.days[Math.round(Number(x))]?.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) ?? ''
const tooltip = componentToString(config, ChartTooltipContent, { labelFormatter: label })
const empty = computed(() => props.days.every(d => Object.values(d.byRole).every(n => n === 0)))
</script>

<template>
  <div class="flex flex-col gap-3">
    <p
      v-if="empty"
      class="flex items-center justify-center text-sm text-muted-foreground"
      :style="{ height: `${height}px` }"
    >
      No tokens used in the last {{ days.length }} days.
    </p>
    <ChartContainer
      v-else
      :config="config"
      class="aspect-auto"
      cursor
      :style="{ height: `${height}px` }"
    >
      <VisXYContainer
        :data="data"
        :margin="{ left: 36, right: 4 }"
        :padding="{ top: 8 }"
      >
        <VisArea
          :x="(d: Row) => d.index"
          :y="y"
          :color="color"
          :opacity="0.55"
          :curve-type="CurveType.MonotoneX"
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
          :tick-format="formatTokens"
          :domain-line="false"
          :tick-line="false"
        />
        <ChartTooltip />
        <ChartCrosshair
          :template="tooltip"
          :color="color"
        />
      </VisXYContainer>
    </ChartContainer>
    <ChartLegend
      v-if="!only"
      :items="roles.map(r => ({ label: r.label, color: r.color }))"
    />
  </div>
</template>
