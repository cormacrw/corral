<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Plan } from '@corral/contracts'
import { plural } from '~/utils/labels'
import { currentTasks } from '~/features/plan/utils/plan-versions'

// What changed since the previous version, collapsed until asked for
const props = defineProps<{ plan: Plan, previous: Plan }>()
const open = ref(false)
watch(() => props.plan.id, () => {
  open.value = false
})

const changeColor = { added: 'success', changed: 'warning', unchanged: 'neutral', removed: 'error' } as const
// Removed Drafts are deleted (D10), so only their count is left to show
const changed = computed(() => currentTasks(props.plan).filter(t => t.change !== 'unchanged'))
const removed = computed(() => props.plan.tasks.length - currentTasks(props.plan).length)
// Which of a changed task's texts differ from the previous version's. Only
// revisions keep their text per version; a Draft shows its current text in
// every version, so a changed Draft gets its badge without this label.
function textChanges(task: Plan['tasks'][number]): string[] {
  const before = props.previous.tasks.find(t => t.key === task.key)
  if (!before || task.change !== 'changed') return []
  return [
    ...before.description !== task.description ? ['description'] : [],
    ...before.implementationPlan !== task.implementationPlan ? ['implementation plan'] : []
  ]
}
</script>

<template>
  <div
    class="border-t border-border px-4 py-3"
  >
    <AppButton
      :label="`Changes from v${props.previous.version}`"
      :icon="open ? 'i-hugeicons-arrow-down-01' : 'i-hugeicons-arrow-right-01'"
      variant="link"
      color="neutral"
      size="sm"
      class="px-0"
      :aria-expanded="open"
      @click="open = !open"
    />
    <p
      v-if="open && changed.length === 0 && removed === 0"
      class="text-xs text-muted-foreground"
    >
      Nothing changed.
    </p>
    <ul
      v-else-if="open"
      class="flex flex-col gap-1 text-xs"
    >
      <li
        v-if="removed"
        class="text-muted-foreground"
      >
        {{ plural(removed, 'task') }} from v{{ props.previous.version }} removed.
      </li>
      <li
        v-for="task in changed"
        :key="task.key"
        class="flex items-center gap-2"
      >
        <AppBadge
          :label="task.revises && task.change === 'added' ? 'Revised' : task.change[0]!.toUpperCase() + task.change.slice(1)"
          :color="changeColor[task.change]"
          variant="subtle"
          size="xs"
          class="w-20 justify-center"
        />
        <span class="truncate">{{ task.title }}</span>
        <span
          v-if="textChanges(task).length"
          class="shrink-0 text-muted-foreground"
        >{{ textChanges(task).join(' and ') }} changed</span>
      </li>
    </ul>
  </div>
</template>
