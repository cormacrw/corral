<script setup lang="ts">
// An agent's page (design/agent.md), with the transcript in the child route.
// Mobile shows the agent and its runs at /agents/:name, and only the
// transcript at /agents/:name/:runId (design/mobile.md).
definePageMeta({ taskFlyout: true })

const route = useRoute()
const device = useDevice()
const view = useAgentRuns()
const { agent } = view
useSeoMeta({ title: () => `${agent.value?.name ?? 'Agent'} · Corral` })
</script>

<template>
  <AppPanel>
    <template v-if="device.isMobile.value">
      <NuxtPage
        v-if="route.params.runId"
        :view="view"
      />
      <MobileAgent
        v-else
        :view="view"
      />
    </template>
    <AgentDetail
      v-else
      :view="view"
    >
      <NuxtPage :view="view" />
    </AgentDetail>
  </AppPanel>
</template>
