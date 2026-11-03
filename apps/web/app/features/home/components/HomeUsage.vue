<script setup lang="ts">
import { tokens } from '~/utils/labels'

// Today's agent totals, scoped to the same project filter
const props = defineProps<{ today: { runs: number, tokens: number }, failed: boolean }>()
const tiles = computed(() => [
  { key: 'runs', label: 'Runs', value: props.failed ? '—' : String(props.today.runs) },
  { key: 'usage', label: 'Usage', value: props.failed ? '—' : tokens(props.today.tokens) }
])
</script>

<template>
  <section class="flex flex-col gap-2">
    <div class="grid grid-cols-2 gap-2">
      <dl
        v-for="tile in tiles"
        :key="tile.key"
        class="rounded-lg border border-border p-3"
        :data-testid="`home-${tile.key}`"
      >
        <dt class="text-xs text-muted-foreground">
          {{ tile.label }}
        </dt>
        <dd class="text-2xl font-semibold tabular-nums text-foreground">
          {{ tile.value }}
        </dd>
      </dl>
    </div>
    <p class="text-xs text-muted-foreground">
      Usage is in tokens from your own subscription.
    </p>
  </section>
</template>
