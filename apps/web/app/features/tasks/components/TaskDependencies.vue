<script setup lang="ts">
import { computed } from 'vue'
import type { PatchTaskInput, Task } from '@corral/contracts'

const props = defineProps<{ task: Task, projectTasks: Task[], readonly: boolean }>()
const emit = defineEmits<{ patch: [input: PatchTaskInput] }>()

const numberOf = (ref: string) => Number(ref.split('-')[1])
const dependencyTask = (ref: string) => props.projectTasks.find(t => t.ref === ref)
const choices = computed(() => props.projectTasks
  .filter(t => t.id !== props.task.id && !props.task.dependsOn.includes(t.ref))
  .map(t => ({ label: `${t.ref} ${t.title}`, value: t.number })))

function add(n: number | null) {
  if (n !== null) emit('patch', { dependsOn: [...props.task.dependsOn.map(numberOf), n] })
}
function remove(ref: string) {
  emit('patch', { dependsOn: props.task.dependsOn.filter(r => r !== ref).map(numberOf) })
}
</script>

<template>
  <section>
    <h3 class="mb-1 text-xs font-medium text-muted-foreground">
      Depends on
    </h3>
    <ul
      v-if="task.dependsOn.length > 0"
      class="flex flex-col gap-1"
    >
      <li
        v-for="ref in task.dependsOn"
        :key="ref"
        class="flex items-center gap-2 text-sm"
      >
        <TaskLink
          :task-ref="ref"
          class="font-mono"
        />
        <span class="truncate">{{ dependencyTask(ref)?.title ?? '' }}</span>
        <StatusBadge
          v-if="dependencyTask(ref)"
          :status="dependencyTask(ref)!.status"
          size="xs"
        />
        <AppButton
          v-if="!readonly"
          icon="i-hugeicons-cancel-01"
          size="xs"
          variant="ghost"
          color="neutral"
          class="tap-target ms-auto shrink-0"
          :aria-label="`Remove dependency ${ref}`"
          @click="remove(ref)"
        />
      </li>
    </ul>
    <p
      v-else
      class="text-sm text-muted-foreground"
    >
      Nothing
    </p>
    <!-- An action, not a value: bound to null, the same task can be added again after removing it -->
    <AppSelectMenu
      v-if="!readonly"
      :model-value="null"
      :items="choices"
      value-key="value"
      placeholder="Add dependency"
      icon="i-hugeicons-add-01"
      variant="ghost"
      size="sm"
      class="mt-1 -ms-2.5"
      :search-input="{ placeholder: 'Search tasks' }"
      @update:model-value="add($event as number | null)"
    />
  </section>
</template>
