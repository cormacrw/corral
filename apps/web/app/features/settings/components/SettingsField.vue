<script setup lang="ts">
// One setting: what it is on the left, its control on the right
defineProps<{ title: string, description: string, for?: string }>()
</script>

<template>
  <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
    <div>
      <component
        :is="$props.for ? 'label' : 'span'"
        :for="$props.for"
        class="font-medium"
      >
        {{ title }}
      </component>
      <p class="text-xs text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <slot />
  </div>
</template>
