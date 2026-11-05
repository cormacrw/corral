<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from 'cn'

// A stat tile: label, hero number, change against the previous period, and
// an optional sparkline. `goodWhen` says which direction is an improvement.
const props = withDefaults(defineProps<{
  label: string
  value: string | number
  hint?: string
  delta?: number
  deltaLabel?: string
  goodWhen?: 'up' | 'down'
  spark?: number[]
  sparkColor?: string
  icon?: string
  class?: HTMLAttributes['class']
}>(), { goodWhen: 'up', hint: undefined, delta: undefined, deltaLabel: undefined, spark: undefined, sparkColor: undefined, icon: undefined, class: undefined })

const good = computed(() => props.delta === undefined || props.delta === 0 ? null : (props.delta > 0) === (props.goodWhen === 'up'))
</script>

<template>
  <div :class="cn('flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4', props.class)">
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <Icon
        v-if="icon"
        :name="icon"
        class="size-4"
      />
      <span class="truncate">{{ label }}</span>
    </div>
    <div class="flex items-end justify-between gap-3">
      <div class="min-w-0">
        <div class="text-2xl font-semibold tracking-tight tabular-nums">
          {{ value }}
        </div>
        <div
          v-if="delta !== undefined || hint"
          class="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground"
        >
          <span
            v-if="delta !== undefined"
            :class="cn('flex items-center gap-0.5 font-medium', good === true && 'text-success', good === false && 'text-destructive')"
          >
            <Icon
              :name="delta >= 0 ? 'i-hugeicons-arrow-up-right-01' : 'i-hugeicons-arrow-down-right-01'"
              class="size-3.5"
            />
            {{ deltaLabel ?? `${delta > 0 ? '+' : ''}${delta}` }}
          </span>
          <span>{{ hint }}</span>
        </div>
      </div>
      <TrendSparkline
        v-if="spark"
        :values="spark"
        :color="sparkColor"
        class="w-16 shrink-0"
      />
    </div>
  </div>
</template>
