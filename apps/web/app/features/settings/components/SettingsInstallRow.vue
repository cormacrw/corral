<script setup lang="ts">
defineProps<{ dense?: boolean }>()
const { open } = useInstall()
</script>

<template>
  <SettingsRow
    icon="i-ri-add-box-line"
    label="Install Corral"
    description="Add it to your home screen"
    :dense="dense"
    data-testid="open-install"
    @click="open = true"
  />
</template>
