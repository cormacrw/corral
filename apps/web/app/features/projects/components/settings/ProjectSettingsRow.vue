<script setup lang="ts">
// One setting: what it is on the left, its control on the right. `for` makes
// the label a real one, for a row with a single named control.
defineProps<{ label: string, hint?: string, for?: string }>()
</script>

<template>
  <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
    <div>
      <component
        :is="$props.for ? 'label' : 'span'"
        :for="$props.for"
        class="font-medium"
      >
        {{ label }}
      </component>
      <p
        v-if="hint"
        class="text-xs text-muted-foreground"
      >
        {{ hint }}
      </p>
    </div>
    <slot />
  </div>
</template>
