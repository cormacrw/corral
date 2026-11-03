<script setup lang="ts">
definePageMeta({ key: 'plan-session' })

const route = useRoute()
</script>

<template>
  <AppPanel>
    <PlanConversation :session-id="String(route.params.sessionId)" />
  </AppPanel>
</template>
