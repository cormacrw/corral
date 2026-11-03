<script setup lang="ts">
defineProps<{ items: readonly { label: string, to: string, icon?: string, active?: boolean }[], orientation?: 'horizontal' | 'vertical' }>()
</script>

<template>
  <nav :class="['flex gap-0.5', orientation === 'vertical' ? 'flex-col' : 'items-center']">
    <AppButton
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      :icon="item.icon"
      :label="item.label"
      variant="ghost"
      :color="item.active ? 'primary' : 'neutral'"
      :class="['justify-start', item.active && 'bg-muted']"
      :aria-current="item.active ? 'page' : undefined"
    />
  </nav>
</template>
