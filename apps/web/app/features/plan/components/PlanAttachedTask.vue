<script setup lang="ts">
// The task being refined, in a Plan composer's header
defineProps<{ taskRef: string }>()
const emit = defineEmits<{ remove: [] }>()
</script>

<template>
  <div class="flex items-center gap-2 text-xs">
    <AppBadge
      variant="subtle"
      color="primary"
    >
      Refining <TaskLink
        :task-ref="taskRef"
        class="underline"
      />
    </AppBadge>
    <AppButton
      icon="i-ri-close-line"
      size="xs"
      variant="ghost"
      color="neutral"
      aria-label="Remove attached task"
      @click="emit('remove')"
    />
  </div>
</template>
