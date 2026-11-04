<script setup lang="ts">
const { isMobile } = useDevice()
</script>

<template>
  <div class="flex w-full items-center justify-between gap-2">
    <span :class="['flex items-center gap-2 font-semibold', isMobile && 'text-lg']">
      <AppLogo class="size-7" />
      Corral
    </span>
    <AppBadge
      label="Self-hosted"
      color="neutral"
      variant="subtle"
    />
  </div>
</template>
