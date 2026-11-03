<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'

const props = defineProps<{ setup: Setup }>()
const { continueLabel, finalStep, canContinue, busy, next } = props.setup
</script>

<template>
  <AppButton
    :label="continueLabel"
    :trailing-icon="finalStep ? 'i-ri-check-line' : 'i-ri-arrow-right-line'"
    :disabled="!canContinue"
    :loading="busy"
    @click="next"
  />
</template>
