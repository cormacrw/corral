<script setup lang="ts">
import type { Project } from '@corral/contracts'
import { ref, watch } from 'vue'
import { initials, projectColor } from '~/utils/labels'

const props = defineProps<{
  project: Pick<Project, 'name' | 'thumbnailColor' | 'thumbnailUrl'>
  size: number
}>()
const failed = ref(false)
watch(() => props.project.thumbnailUrl, () => {
  failed.value = false
})
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold text-white"
    :class="[size >= 36 ? 'rounded-lg' : 'rounded', size >= 44 ? 'text-lg' : size >= 36 ? 'text-sm' : 'text-[10px]']"
    :style="{ width: `${size}px`, height: `${size}px`, background: projectColor(project) }"
  >
    <img
      v-if="project.thumbnailUrl && !failed"
      :key="project.thumbnailUrl"
      :src="project.thumbnailUrl"
      :alt="project.name"
      class="size-full object-cover"
      @error="failed = true"
    >
    <template v-else>{{ initials(project.name) }}</template>
  </span>
</template>
