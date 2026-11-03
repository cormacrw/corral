<script setup lang="ts">
import { ref } from 'vue'
import { reloadShell } from '~/queries/shell'
import { usePlanRunner } from '~/features/plan/composables/usePlanRunner'

// Plan needs the runner (design/plan.md). Phones can Reconnect; `hint` adds a
// next step on the web.
defineProps<{ hint?: string }>()
const device = useDevice()
const { pm, offline } = usePlanRunner()
const reconnecting = ref(false)
// Re-reads the runner's status, in case its live update was missed
async function reconnect() {
  reconnecting.value = true
  try {
    await reloadShell()
  } finally {
    reconnecting.value = false
  }
}
</script>

<template>
  <AppAlert
    v-if="offline && device.isMobile.value"
    color="error"
    variant="subtle"
    icon="i-hugeicons-alert-02"
    title="Plan needs the runner. It's offline."
    :description="`${pm?.name ?? 'The PM'} runs in the runner container. Your sessions and drafts are safe.`"
    :actions="[{ label: 'Reconnect', color: 'error', variant: 'outline', loading: reconnecting, onClick: reconnect }]"
    data-testid="plan-runner-offline"
  />
  <AppAlert
    v-else-if="offline"
    color="warning"
    variant="subtle"
    icon="i-hugeicons-server-stack-01"
    title="Plan needs the runner. It's offline."
    :description="hint"
  />
</template>
