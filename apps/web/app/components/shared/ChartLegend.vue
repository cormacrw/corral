<script setup lang="ts">
// A chart's legend: a colour swatch beside each series name, and its value
defineProps<{ items: { label: string, color: string, value?: string | number }[] }>()
</script>

<template>
  <ul class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
    <li
      v-for="item in items"
      :key="item.label"
      class="flex items-center gap-1.5"
    >
      <span
        class="size-2.5 rounded-xs"
        :style="{ background: item.color }"
      />
      <span>{{ item.label }}</span>
      <span
        v-if="item.value !== undefined"
        class="font-medium text-foreground tabular-nums"
      >{{ item.value }}</span>
    </li>
  </ul>
</template>
