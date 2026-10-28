<script setup lang="ts">
import type { TaskStatus } from '@corral/core'
import { STATUS } from '~/utils/labels'

// A status is always shown with its label; colour is never the only signal
const props = withDefaults(defineProps<{ status: TaskStatus, size?: 'xs' | 'sm' | 'md' }>(), { size: 'sm' })
</script>

<template>
  <UBadge
    :label="STATUS[props.status].label"
    :color="STATUS[props.status].color"
    variant="subtle"
    :size="props.size"
  />
</template>
