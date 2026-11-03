<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'

// The current step's fields, the same on both layouts
const props = defineProps<{ setup: Setup }>()
const { step } = props.setup
</script>

<template>
  <SetupYouStep
    v-if="step === 'you'"
    :setup="setup"
  />
  <SetupRepoStep
    v-else-if="step === 'repo'"
    :setup="setup"
  />
  <SetupAgentsStep
    v-else-if="step === 'agents'"
    :setup="setup"
  />
  <SetupNamesStep
    v-else
    :setup="setup"
  />
</template>
