<script setup lang="ts">
const ITEMS = [{ label: 'System', value: 'system' }, { label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }]
const colorMode = useColorMode()
</script>

<template>
  <AppTabs
    :model-value="colorMode.preference"
    :items="ITEMS"
    :content="false"
    aria-label="Colour mode"
    @update:model-value="colorMode.preference = String($event)"
  />
</template>
