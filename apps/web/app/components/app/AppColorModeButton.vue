<script setup lang="ts">
const colorMode = useColorMode()
const dark = computed(() => colorMode.value === 'dark')
</script>

<template>
  <AppButton
    :icon="dark ? 'i-ri-moon-line' : 'i-ri-sun-line'"
    variant="ghost"
    color="neutral"
    :aria-label="`Switch to ${dark ? 'light' : 'dark'} mode`"
    @click="colorMode.preference = dark ? 'light' : 'dark'"
  />
</template>
