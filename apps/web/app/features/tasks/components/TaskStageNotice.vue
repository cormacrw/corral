<script setup lang="ts">
import type { Task } from '@corral/contracts'

// What this stage of the task means: read-only, a plan's Draft, or Backlog
defineProps<{ task: Task, placing: boolean }>()
const emit = defineEmits<{ place: [] }>()
const bannerClass = 'flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm'
</script>

<template>
  <p
    v-if="task.status === 'merged'"
    class="flex items-center gap-1.5 text-xs text-muted-foreground"
  >
    <Icon
      name="i-ri-lock-line"
      class="size-3.5"
    />
    Complete, so read-only. You can still comment.
  </p>
  <!-- A Draft from a plan: the task itself, without the work around it. It's
       placed only with the whole plan, from the plan flyout -->
  <div
    v-else-if="task.status === 'draft'"
    :class="bannerClass"
  >
    <span class="me-auto text-muted-foreground">Proposed in a plan. Only you can see it until you add the plan to the board or the Backlog.</span>
    <AppButton
      v-if="task.draftSession?.id"
      label="Open plan session"
      trailing-icon="i-ri-arrow-right-line"
      variant="link"
      size="sm"
      :to="`/plan/${task.draftSession.id}`"
      data-testid="task-plan-session"
    />
  </div>
  <div
    v-else-if="task.status === 'backlog'"
    :class="bannerClass"
  >
    <span class="me-auto text-muted-foreground">In the Backlog, so never scheduled until you move it.</span>
    <AppButton
      label="Move to board"
      icon="i-ri-kanban-view"
      size="sm"
      :loading="placing"
      @click="emit('place')"
    />
  </div>
</template>
