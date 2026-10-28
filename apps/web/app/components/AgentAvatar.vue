<script setup lang="ts">
import { initials } from '~/utils/labels'

// An agent's avatar with the working status dot (shared working indicator)
const props = withDefaults(defineProps<{
  name: string
  working?: boolean
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
}>(), { working: false, size: 'sm' })
</script>

<template>
  <span class="relative inline-flex shrink-0">
    <UAvatar
      :text="initials(props.name)"
      :size="props.size"
      :alt="props.name"
    />
    <span
      v-if="props.working"
      class="absolute -end-0.5 -bottom-0.5 flex size-2.5"
      aria-hidden="true"
    >
      <span class="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75 motion-reduce:hidden" />
      <span class="relative inline-flex size-2.5 rounded-full border border-default bg-success" />
    </span>
  </span>
</template>
