<script setup lang="ts">
import type { DashboardCounts } from '~/features/home/utils/dashboard'

// In progress by stage, and what's waiting on the human
defineProps<{
  stages: { key: string, label: string, count: number, color: string }[]
  counts: DashboardCounts
  attention: string | null
}>()
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-lg border border-border p-3"
    data-testid="home-stages"
  >
    <header class="flex items-center justify-between">
      <h2 class="text-sm font-semibold text-foreground">
        In progress by stage
      </h2>
      <span class="text-xs text-muted-foreground">{{ counts.inProgress }} {{ counts.inProgress === 1 ? 'task' : 'tasks' }}</span>
    </header>
    <div
      class="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted"
      role="img"
      :aria-label="stages.map(s => `${s.label} ${s.count}`).join(', ')"
    >
      <span
        v-for="stage in stages.filter(s => s.count > 0)"
        :key="stage.key"
        class="h-full"
        :style="{ flex: stage.count, background: stage.color }"
        :title="`${stage.label}: ${stage.count}`"
      />
    </div>
    <ul class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
      <li
        v-for="stage in stages"
        :key="stage.key"
        class="flex items-center gap-2"
      >
        <span
          class="size-2 shrink-0 rounded-full"
          :style="{ background: stage.color }"
          aria-hidden="true"
        />
        <span class="flex-1 truncate">{{ stage.label }}</span>
        <span class="font-semibold tabular-nums text-foreground">{{ stage.count }}</span>
      </li>
    </ul>
    <NuxtLink
      v-if="attention"
      to="/inbox"
      :class="['flex items-center gap-2 rounded-md border px-3 py-2 text-sm', counts.blocked ? 'border-destructive/30 bg-destructive/10' : 'border-warning/30 bg-warning/10']"
      data-testid="home-attention"
    >
      <Icon
        name="i-hugeicons-alert-02"
        :class="['size-4 shrink-0', counts.blocked ? 'text-destructive' : 'text-warning']"
      />
      <span class="flex-1">{{ attention }}</span>
      <Icon
        name="i-hugeicons-arrow-right-01"
        class="size-4 text-muted-foreground"
      />
    </NuxtLink>
  </section>
</template>
