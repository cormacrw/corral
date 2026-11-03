<script setup lang="ts">
const { isMobile } = useDevice()
</script>

<template>
  <div class="flex w-full items-center justify-between gap-2">
    <span :class="['flex items-center gap-2 font-semibold', isMobile && 'text-lg']">
      <span class="flex size-7 items-center justify-center rounded-md bg-primary text-background"><Icon
        name="i-ri-shield-star-line"
        class="size-4"
      /></span>
      Corral
    </span>
    <AppBadge
      label="Self-hosted"
      color="neutral"
      variant="subtle"
    />
  </div>
</template>
