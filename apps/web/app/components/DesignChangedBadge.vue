<script setup lang="ts">
import type { Task } from '@corral/contracts'

// Flags a build task whose design has a newer approved version than the
// one it's pinned to, while it hasn't started (D20)
const props = defineProps<{ design: Task['design'] }>()
const stale = computed(() => props.design?.newerVersion ? props.design : null)
</script>

<template>
  <UTooltip
    v-if="stale"
    :text="`Pinned to v${stale.version} of ${stale.taskRef}; v${stale.newerVersion} has been approved since`"
  >
    <UBadge
      :label="`Design changed: v${stale.version} → v${stale.newerVersion}`"
      icon="i-lucide-palette"
      color="warning"
      variant="subtle"
      size="sm"
      class="shrink-0"
    />
  </UTooltip>
</template>
