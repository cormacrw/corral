<script setup lang="ts">
import type { Project } from '@corral/contracts'
import type { OpenStage } from '~/features/home/utils/overview'
import { OPEN_STAGES } from '~/features/home/utils/overview'
import { STATUS } from '~/utils/labels'

// Each project's open work as one bar split by stage, Backlog excluded. One
// hue, light to dark, because the stages are in order.
const props = defineProps<{ rows: { project: Project & { color: string }, total: number, stages: Record<OpenStage, number> }[] }>()

const COLORS: Record<OpenStage, string> = {
  ready: 'var(--chart-1)',
  in_progress: 'var(--chart-2)',
  agent_review: 'var(--chart-3)',
  human_review: 'var(--chart-4)',
  ready_to_merge: 'var(--chart-5)'
}
const max = computed(() => Math.max(1, ...props.rows.map(r => r.total)))
const bars = computed(() => props.rows.map(r => ({
  ...r,
  parts: OPEN_STAGES.filter(s => r.stages[s] > 0).map(s => ({ stage: s, count: r.stages[s] }))
})))
const legend = OPEN_STAGES.map(s => ({ label: STATUS[s].label, color: COLORS[s] }))
</script>

<template>
  <div class="flex flex-col gap-3">
    <NuxtLink
      v-for="r in bars"
      :key="r.project.id"
      :to="`/projects/${r.project.slug}/board`"
      class="-mx-2 grid grid-cols-[minmax(0,7rem)_1fr_2rem] items-center gap-3 rounded-md px-2 py-1 text-sm hover:bg-muted"
    >
      <span class="flex items-center gap-1.5 truncate">
        <span
          class="size-2 shrink-0 rounded-full"
          :style="{ background: r.project.color }"
          aria-hidden="true"
        />
        <span class="truncate">{{ r.project.name }}</span>
      </span>
      <div
        class="flex h-3 gap-0.5"
        :style="{ width: `${(r.total / max) * 100}%` }"
      >
        <AppTooltip
          v-for="part in r.parts"
          :key="part.stage"
          :text="`${STATUS[part.stage].label}: ${part.count}`"
        >
          <span
            class="h-full rounded-[3px]"
            :style="{ flexGrow: part.count, background: COLORS[part.stage] }"
          />
        </AppTooltip>
      </div>
      <span class="text-end font-medium tabular-nums">{{ r.total }}</span>
    </NuxtLink>
    <p
      v-if="rows.length === 0"
      class="text-sm text-muted-foreground"
    >
      No projects yet.
    </p>
    <ChartLegend :items="legend" />
  </div>
</template>
