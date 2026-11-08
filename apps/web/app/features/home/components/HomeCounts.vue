<script setup lang="ts">
import type { DashboardCounts } from '~/features/home/utils/figures'

const props = defineProps<{ counts: DashboardCounts, loading: boolean }>()
const tiles = computed(() => [
  { key: 'todo', label: 'To do', dot: 'bg-info', value: props.counts.todo, sub: 'Ready, not started' },
  { key: 'in-progress', label: 'In progress', dot: 'bg-primary', value: props.counts.inProgress, sub: 'Building to merge' },
  { key: 'merged', label: 'Completed today', dot: 'bg-success', value: props.counts.mergedToday, sub: `${props.counts.firstPassToday} first-pass` }
])
</script>

<template>
  <div class="grid grid-cols-3 gap-2">
    <dl
      v-for="tile in tiles"
      :key="tile.key"
      class="flex flex-col rounded-lg border border-border p-3"
      :data-testid="`home-${tile.key}`"
    >
      <dt class="flex items-start gap-1.5 text-xs text-muted-foreground">
        <span
          :class="['mt-1 size-2 shrink-0 rounded-full', tile.dot]"
          aria-hidden="true"
        />{{ tile.label }}
      </dt>
      <dd class="text-3xl font-semibold tabular-nums text-foreground">
        <UiSkeleton
          v-if="loading"
          class="my-1 h-7 w-8"
        />
        <template v-else>
          {{ tile.value }}
        </template>
      </dd>
      <dd class="text-xs text-muted-foreground">
        {{ tile.sub }}
      </dd>
    </dl>
  </div>
</template>
