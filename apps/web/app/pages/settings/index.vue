<script setup lang="ts">
import SettingsProfile from './profile.vue'

const device = useDevice()
</script>

<template>
  <SettingsMobile v-if="device.isMobile.value" />
  <SettingsProfile v-else />
</template>
