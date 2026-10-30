<script setup lang="ts">
// The Projects tab: MobileProjects on mobile (design/mobile.md), a plain
// project list on the web
const state = useLive().state
const device = useDevice()
useSeoMeta({ title: 'Projects · Corral' })
</script>

<template>
  <div
    v-if="device.isMobile.value"
    class="flex min-h-0 min-w-0 flex-1 flex-col"
  >
    <MobileProjects />
  </div>
  <UDashboardPanel v-else>
    <div class="flex flex-col gap-2 p-4">
      <UButton
        v-for="project in state.projects"
        :key="project.id"
        :to="`/projects/${project.slug}`"
        variant="outline"
        color="neutral"
        class="justify-start"
      >
        <ProjectThumbnail
          :project="project"
          :size="24"
        />
        <span class="truncate">{{ project.name }}</span>
        <span
          v-if="project.paused"
          class="ms-auto text-xs text-warning"
        >Paused</span>
      </UButton>
      <UButton
        to="/setup?step=repo&add=1"
        icon="i-lucide-plus"
        label="Add project"
        variant="ghost"
        color="neutral"
        class="self-start"
      />
    </div>
  </UDashboardPanel>
</template>
