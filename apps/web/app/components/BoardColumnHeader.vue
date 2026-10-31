<script setup lang="ts">
// A Board column's header: its dot, name, count and whose turn it is
defineProps<{ label: string, hint: string, count: number, dot: string }>()
</script>

<template>
  <header class="flex shrink-0 items-center gap-2 px-3 py-2.5 text-sm">
    <span
      :class="['size-2 rounded-full', dot]"
      aria-hidden="true"
    />
    <span class="font-medium">{{ label }}</span>
    <UBadge
      :label="String(count)"
      size="xs"
      variant="subtle"
      color="neutral"
    />
    <span class="ms-auto text-xs text-muted">{{ hint }}</span>
  </header>
</template>
