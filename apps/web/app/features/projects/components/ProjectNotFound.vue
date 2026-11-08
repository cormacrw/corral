<script setup lang="ts">
import { SECTIONS } from '~/utils/routes'
// What every /projects/:slug route shows for a project that doesn't exist,
// such as one just removed
const device = useDevice()
useSeoMeta({ title: 'Project not found · Corral' })
</script>

<template>
  <AppPanel>
    <MobilePageHeader v-if="device.isMobile.value" />
    <div
      class="flex flex-col items-center gap-3 p-12 text-center"
      data-testid="project-not-found"
    >
      <h1 class="text-lg font-semibold text-foreground">
        Project not found
      </h1>
      <p class="text-sm text-muted-foreground">
        It doesn't exist, or it was removed from Corral.
      </p>
      <AppButton
        label="All projects"
        :to="SECTIONS.projects.to"
        color="neutral"
        variant="outline"
      />
    </div>
  </AppPanel>
</template>
