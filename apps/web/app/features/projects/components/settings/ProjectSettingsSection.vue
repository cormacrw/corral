<script setup lang="ts">
defineProps<{ title: string, danger?: boolean }>()
</script>

<template>
  <AppCard :class="danger && 'ring-destructive/40'">
    <template #header>
      <h2 :class="['font-medium', danger && 'text-destructive']">
        {{ title }}
      </h2>
    </template>
    <div class="flex flex-col gap-5">
      <slot />
    </div>
  </AppCard>
</template>
