<script setup lang="ts">
// The one "this didn't load" state. Pass `retry` to offer another attempt.
defineProps<{ title: string, description?: string, retry?: () => unknown }>()
</script>

<template>
  <AppAlert
    color="error"
    variant="subtle"
    icon="i-hugeicons-alert-circle"
    :title="title"
    :description="description"
    :actions="retry ? [{ label: 'Retry', onClick: retry }] : []"
  />
</template>
