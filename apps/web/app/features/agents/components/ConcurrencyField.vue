<script setup lang="ts">
import type { Agent } from '@corral/contracts'
import { useConcurrency } from '~/features/agents/composables/useConcurrency'

const props = defineProps<{ agent: Pick<Agent, 'id' | 'concurrency'> }>()
const { value, set } = useConcurrency(() => props.agent)
</script>

<template>
  <AppFormField label="Concurrency">
    <AppNumberInput
      :model-value="value"
      :min="1"
      class="w-28"
      @update:model-value="$event && set($event)"
    />
  </AppFormField>
</template>
