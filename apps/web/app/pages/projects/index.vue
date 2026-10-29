<script setup lang="ts">
import { initials, projectColor } from '~/utils/labels'

// Placeholder for the mobile Projects tab (design/mobile.md); its real
// screen comes in a later task
const state = useLive().state
useSeoMeta({ title: 'Projects · Corral' })
</script>

<template>
  <UDashboardPanel>
    <div class="flex flex-col gap-2 p-4">
      <UButton
        v-for="project in state.projects"
        :key="project.id"
        :to="`/projects/${project.slug}`"
        variant="outline"
        color="neutral"
        class="justify-start"
      >
        <span
          class="flex size-6 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
          :style="{ background: projectColor(project) }"
        >{{ initials(project.name) }}</span>
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
