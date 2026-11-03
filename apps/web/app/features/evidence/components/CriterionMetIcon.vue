<script setup lang="ts">
import { computed } from 'vue'

// A criterion's verdict: met, not met, or null until a review says
const props = defineProps<{ met?: boolean | null }>()
const state = computed(() => props.met
  ? { icon: 'i-ri-checkbox-circle-line', tone: 'text-success', label: 'Met' }
  : props.met === false
    ? { icon: 'i-ri-close-circle-line', tone: 'text-destructive', label: 'Not met' }
    : { icon: 'i-ri-circle-line', tone: 'text-muted-foreground/70', label: 'Open' })
</script>

<template>
  <Icon
    :name="state.icon"
    :class="['size-4 shrink-0', state.tone]"
    :aria-label="state.label"
  />
</template>
