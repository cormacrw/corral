<script setup lang="ts">
import { computed } from 'vue'

// Picks a Backlog task to refine, in a Plan composer's toolbar
const props = defineProps<{ project: { slug: string } | null }>()
const taskRef = defineModel<string | null>({ required: true })
const { tasks } = useProjectLists(() => props.project?.slug ?? '')
const items = computed(() => props.project
  ? tasks.value.filter(t => t.status === 'backlog').map(t => ({ label: `${t.ref} ${t.title}`, value: t.ref }))
  : [])
</script>

<template>
  <AppSelectMenu
    v-if="project"
    :model-value="taskRef ?? undefined"
    :items="items"
    value-key="value"
    size="xs"
    variant="ghost"
    icon="i-hugeicons-task-done-01"
    placeholder="Refine a task"
    :search-input="{ placeholder: 'Search Backlog' }"
    aria-label="Refine a task"
    content-class="w-80 max-w-[calc(100vw-2rem)]"
    class="w-auto max-w-56"
    @update:model-value="taskRef = ($event as string | null)"
  />
</template>
