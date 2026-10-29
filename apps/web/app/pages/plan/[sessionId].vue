<script setup lang="ts">
const route = useRoute()
</script>

<template>
  <PlanConversation :session-id="String(route.params.sessionId)" />
</template>
