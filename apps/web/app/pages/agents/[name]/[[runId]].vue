<script setup lang="ts">
import type { AgentRuns } from '~/features/runs/composables/useAgentRuns'

// The transcript of the selected run, inside the agent page. On mobile this
// route only shows with a run in the URL (design/mobile.md).
// One key for every run: the panes key themselves by the selected run, so
// reaching the auto-selected run by URL keeps its draft, and Nuxt only syncs
// the shell's route between runs when this key doesn't change.
definePageMeta({ key: 'agent-run' })

defineProps<{ view: AgentRuns }>()
const device = useDevice()
</script>

<template>
  <MobileAgentRun
    v-if="device.isMobile.value"
    :view="view"
  />
  <AgentRunPanel
    v-else
    :view="view"
  />
</template>
