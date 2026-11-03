<script setup lang="ts">
// A section heading in the project overview. On a phone the project's name is
// the h2, so sections sit a level below it.
defineProps<{ mobile?: boolean }>()
</script>

<template>
  <component
    :is="mobile ? 'h3' : 'h2'"
    :class="mobile ? 'text-sm font-semibold text-foreground' : 'font-medium'"
  >
    <slot />
  </component>
</template>
