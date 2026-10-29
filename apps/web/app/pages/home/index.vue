<script setup lang="ts">
// Placeholder for the mobile Home tab (design/mobile.md); its real screen
// comes in a later task
const state = useLive().state
useSeoMeta({ title: 'Home · Corral' })
</script>

<template>
  <UDashboardPanel>
    <div class="flex flex-col gap-4 p-4">
      <p class="text-sm text-muted">
        Runner {{ state.runner?.online ? 'online' : 'offline' }} · {{ state.projects.length }} {{ state.projects.length === 1 ? 'project' : 'projects' }}
      </p>
      <UButton
        to="/inbox"
        icon="i-lucide-inbox"
        color="neutral"
        variant="soft"
        :label="`${state.inboxCount} ${state.inboxCount === 1 ? 'item needs' : 'items need'} you`"
        class="self-start"
      />
    </div>
  </UDashboardPanel>
</template>
