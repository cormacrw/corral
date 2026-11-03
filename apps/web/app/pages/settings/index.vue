<script setup lang="ts">
const device = useDevice()
</script>

<template>
  <SettingsMobile v-if="device.isMobile.value" />
  <SettingsProfile v-else />
</template>
