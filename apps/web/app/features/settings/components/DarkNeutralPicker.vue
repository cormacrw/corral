<script setup lang="ts">
import { DARK_NEUTRALS } from '~/features/settings/utils/dark-neutral'

const { palette, setPalette } = useDarkNeutral()
</script>

<template>
  <div
    role="group"
    aria-label="Dark background"
    class="flex flex-wrap gap-2"
  >
    <AppButton
      v-for="option in DARK_NEUTRALS"
      :key="option"
      color="neutral"
      :variant="palette === option ? 'subtle' : 'outline'"
      :aria-pressed="palette === option"
      :data-palette="option"
      @click="setPalette(option)"
    >
      <span
        class="size-3 shrink-0 rounded-full ring ring-border"
        :style="{ backgroundColor: `var(--dark-neutral-${option}-900)` }"
        aria-hidden="true"
      />
      <span class="capitalize">{{ option }}</span>
      <Icon
        v-if="palette === option"
        name="i-hugeicons-tick-02"
        class="size-3"
      />
    </AppButton>
  </div>
</template>
