<script setup lang="ts">
definePageMeta({ key: 'plan-session' })

const route = useRoute()
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <PlanConversation :session-id="String(route.params.sessionId)" />
  </UDashboardPanel>
</template>
