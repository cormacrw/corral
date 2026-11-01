<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { PRIORITY, cardTypeIcon } from '~/utils/labels'

// A Board task card on desktop and phone (design/board.md). The card is a div
// with its title as the keyboard control, so it can hold other buttons. A
// click anywhere does what the title does: emits `open`, or follows `to` when
// the title is a link. `pressed` marks a card that toggles, as on desktop.
const props = defineProps<{
  task: Task
  tasks: Task[]
  epic?: string | null
  to?: string
  pressed?: boolean
}>()
const emit = defineEmits<{ open: [] }>()

const typeIcon = computed(() => cardTypeIcon(props.task.type))
const priorityClass = computed(() => props.task.priority === 'urgent' ? 'text-error' : props.task.priority === 'high' ? 'text-warning' : 'text-muted')

function onClick(event: MouseEvent) {
  if (!props.to) emit('open')
  // The title's own link has already navigated
  else if (!(event.target as Element).closest('a')) void navigateTo(props.to)
}
</script>

<template>
  <BorderGlow
    :active="Boolean(task.lease)"
    :glow-radius="8"
    class="shrink-0"
  >
    <div
      :class="[
        'flex shrink-0 cursor-pointer flex-col gap-1.5 rounded-md border border-default bg-default px-3 py-2.5 text-sm has-[[data-card-title]:focus-visible]:ring-2 has-[[data-card-title]:focus-visible]:ring-primary',
        to ? 'active:bg-elevated' : 'hover:border-accented',
        task.lease && 'border-primary/60',
        pressed && 'border-primary ring-1 ring-primary'
      ]"
      data-testid="task-card"
      @click="onClick"
    >
      <NuxtLink
        v-if="to"
        :to="to"
        data-card-title
        class="font-medium wrap-anywhere text-highlighted outline-none"
      >
        {{ task.title }}
      </NuxtLink>
      <button
        v-else
        type="button"
        :aria-pressed="pressed"
        data-card-title
        class="cursor-pointer text-start font-medium wrap-anywhere text-highlighted outline-none"
      >
        {{ task.title }}
      </button>
      <span
        v-if="epic"
        class="truncate text-xs text-muted"
      >{{ epic }}</span>
      <span class="flex items-center gap-2 text-xs">
        <span :class="priorityClass">{{ PRIORITY[task.priority].label }}</span>
        <span class="ms-auto flex items-center gap-2">
          <TaskCardBlockers
            :task="task"
            :tasks="tasks"
          />
          <UIcon
            v-if="typeIcon"
            :name="typeIcon.name"
            role="img"
            :aria-label="typeIcon.label"
            class="size-4 text-muted"
          />
          <TaskCardAssignee :task="task" />
        </span>
      </span>
    </div>
  </BorderGlow>
</template>
