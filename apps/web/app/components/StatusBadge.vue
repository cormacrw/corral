<script setup lang="ts">
import type { TaskStatus } from '@corral/core'
import { STATUS } from '~/utils/labels'

// A status is always shown with its label; colour is never the only signal
// `label` replaces the status name, e.g. to add a count
const props = withDefaults(defineProps<{ status: TaskStatus, size?: 'xs' | 'sm' | 'md', label?: string }>(), { size: 'sm', label: undefined })
</script>

<template>
  <UBadge
    :label="props.label ?? STATUS[props.status].label"
    :color="STATUS[props.status].color"
    variant="subtle"
    :size="props.size"
  />
</template>
