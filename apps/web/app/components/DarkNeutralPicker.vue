<script setup lang="ts">
import { DARK_NEUTRALS } from '~/utils/dark-neutral'

const { palette, setPalette } = useDarkNeutral()
</script>

<template>
  <div
    role="group"
    aria-label="Dark background"
    class="flex flex-wrap gap-2"
  >
    <UButton
      v-for="option in DARK_NEUTRALS"
      :key="option"
      color="neutral"
      :variant="palette === option ? 'subtle' : 'outline'"
      :aria-pressed="palette === option"
      :data-palette="option"
      @click="setPalette(option)"
    >
      <span
        class="size-3 shrink-0 rounded-full ring ring-default"
        :style="{ backgroundColor: `var(--dark-neutral-${option}-900)` }"
        aria-hidden="true"
      />
      <span class="capitalize">{{ option }}</span>
      <UIcon
        v-if="palette === option"
        name="i-lucide-check"
        class="size-3"
      />
    </UButton>
  </div>
</template>
