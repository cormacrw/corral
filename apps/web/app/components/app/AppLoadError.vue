<script setup lang="ts">
// The one "this didn't load" state. Pass `retry` to offer another attempt.
defineProps<{ title: string, description?: string, retry?: () => unknown, retrying?: boolean }>()
</script>

<template>
  <AppAlert
    color="error"
    variant="subtle"
    icon="i-ri-error-warning-line"
    :title="title"
    :description="description"
    :actions="retry ? [{ label: 'Retry', loading: retrying, onClick: retry }] : []"
  />
</template>
