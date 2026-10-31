<script setup lang="ts">
// What every /projects/:slug route shows for a project that doesn't exist,
// such as one just removed
const device = useDevice()
useSeoMeta({ title: 'Project not found · Corral' })
</script>

<template>
  <UDashboardPanel>
    <MobilePageHeader v-if="device.isMobile.value" />
    <div
      class="flex flex-col items-center gap-3 p-12 text-center"
      data-testid="project-not-found"
    >
      <h1 class="text-lg font-semibold text-highlighted">
        Project not found
      </h1>
      <p class="text-sm text-muted">
        It doesn't exist, or it was removed from Corral.
      </p>
      <UButton
        label="All projects"
        to="/projects"
        color="neutral"
        variant="outline"
      />
    </div>
  </UDashboardPanel>
</template>
