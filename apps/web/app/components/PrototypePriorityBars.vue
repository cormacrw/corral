<script setup lang="ts">
// Priority as a rising signal: one bar for Low up to four for Urgent
defineProps<{ level: number, label?: string }>()
</script>

<template>
  <span
    :role="label ? 'img' : undefined"
    :aria-label="label ? `${label} priority` : undefined"
    :aria-hidden="label ? undefined : true"
    :title="label"
    class="flex h-3 shrink-0 items-end gap-0.5"
  >
    <span
      v-for="bar in 4"
      :key="bar"
      :class="['w-0.5 rounded-full', bar <= level ? 'bg-current' : 'bg-accented']"
      :style="{ height: `${25 * bar}%` }"
    />
  </span>
</template>
