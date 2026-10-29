<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { taskTypeBadge } from '~/utils/labels'

// Marks Bug and Spike cards on the Board and Backlog (D19)
const props = defineProps<{ type: Task['type'] }>()
const badge = computed(() => taskTypeBadge(props.type))
</script>

<template>
  <UBadge
    v-if="badge"
    :label="badge.label"
    :icon="badge.icon"
    :color="badge.color"
    variant="subtle"
    size="sm"
    class="shrink-0"
  />
</template>
