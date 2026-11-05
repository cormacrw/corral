<script setup lang="ts">
import { Timeline } from '@unovis/ts'
import { VisAxis, VisTimeline, VisTooltip, VisXYContainer } from '@unovis/vue'
import type { RunBar } from '~/features/agents/utils/fleet'
import { RUN_TONE } from '~/features/agents/utils/fleet'
import { runRef, runTitle } from '~/utils/labels'

// Every agent run over the last `hours` hours, one lane per agent (unovis
// Timeline). Now is at the right edge.
const props = defineProps<{ bars: RunBar[], hours: number }>()

const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const minutes = (hours: number) => {
  const m = Math.max(1, Math.round(hours * 60))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const triggers = {
  [Timeline.selectors.line]: (d: RunBar) => `<div class="text-xs leading-snug"><b>${escape(d.run.agentName)}</b> · ${escape(runRef(d.run) || runTitle(d.run))}<br>${RUN_TONE[d.tone].label} · ${minutes(d.hours)}</div>`
}
// @unovis/vue's Timeline declares no props, so attributes reach it as written
// and kebab-case names never match its camelCase config. Bind an object.
const timeline = {
  x: (d: RunBar) => d.x,
  lineDuration: (d: RunBar) => d.hours,
  lineRow: (d: RunBar) => d.lane,
  color: (d: RunBar) => RUN_TONE[d.tone].color,
  rowHeight: 30,
  lineWidth: 10,
  lineCap: true,
  showRowLabels: true,
  rowLabelWidth: 72,
  alternatingRowColors: false
}
// As tall as its lanes, plus the axis
const height = computed(() => new Set(props.bars.map(b => b.lane)).size * timeline.rowHeight + 36)
const ticks = computed(() => Array.from({ length: props.hours / 2 + 1 }, (_, i) => i * 2))
const tick = (v: number) => v === props.hours ? 'now' : `-${props.hours - v}h`
const legend = Object.values(RUN_TONE).map(t => ({ label: t.label, color: t.color }))
</script>

<template>
  <div class="flex flex-col gap-3">
    <p
      v-if="bars.length === 0"
      class="py-10 text-center text-sm text-muted-foreground"
    >
      No runs in the last {{ hours }} hours.
    </p>
    <VisXYContainer
      v-else
      :data="bars"
      :x-domain="[0, hours]"
      :height="height"
      :margin="{ right: 8 }"
    >
      <VisTimeline v-bind="timeline" />
      <VisAxis
        type="x"
        :tick-format="tick"
        :tick-values="ticks"
        :grid-line="true"
        :domain-line="false"
        :tick-line="false"
      />
      <VisTooltip :triggers="triggers" />
    </VisXYContainer>
    <ChartLegend :items="legend" />
  </div>
</template>
