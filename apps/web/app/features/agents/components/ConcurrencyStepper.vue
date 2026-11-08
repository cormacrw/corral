<script setup lang="ts">
import type { Agent } from '@corral/contracts'
import { useConcurrency } from '~/features/agents/composables/useConcurrency'

const props = defineProps<{ agent: Pick<Agent, 'id' | 'name' | 'concurrency' | 'activeRuns'>, fullWidth?: boolean, compact?: boolean }>()
const { value, showSaved, step } = useConcurrency(() => props.agent)
</script>

<template>
  <div :class="['flex items-center', compact ? 'flex-col gap-1' : 'gap-3']">
    <div :class="['flex flex-col items-center', fullWidth && 'w-full']">
      <div :class="['flex items-center', compact ? 'gap-1' : 'gap-2', fullWidth && 'w-full justify-between']">
        <AppButton
          icon="i-hugeicons-minus-sign"
          color="neutral"
          variant="outline"
          size="xl"
          class="size-11 justify-center"
          :disabled="value <= 1"
          :aria-label="`Decrease concurrency for ${props.agent.name}`"
          @click="step(-1)"
        />
        <span
          :class="['text-center font-semibold text-foreground tabular-nums', compact ? 'min-w-6 text-base' : 'min-w-10 text-2xl']"
          aria-live="polite"
          data-testid="concurrency"
        >{{ value }}</span>
        <AppButton
          icon="i-hugeicons-add-01"
          color="neutral"
          variant="outline"
          size="xl"
          class="size-11 justify-center"
          :aria-label="`Increase concurrency for ${props.agent.name}`"
          @click="step(1)"
        />
      </div>
      <p
        v-if="props.agent.activeRuns > 0"
        class="text-xs text-muted-foreground"
      >
        {{ props.agent.activeRuns }} running now
      </p>
    </div>
    <span
      v-if="showSaved"
      class="text-xs text-muted-foreground"
      role="status"
    >Saved</span>
  </div>
</template>
