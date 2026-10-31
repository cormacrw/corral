<script setup lang="ts">
import type { Agent, Task } from '@corral/contracts'
import { PRIORITY } from '~/utils/labels'
import type { taskNote } from '~/utils/labels'

// One card on the desktop Board. Its own component, so opening a task updates
// the two cards that changed rather than the whole Board.
const props = defineProps<{
  task: Task
  selected: boolean
  draggable: boolean
  note: ReturnType<typeof taskNote>
  epic: string | null
  agent: Agent | null
  slug: string
}>()
const emit = defineEmits<{ open: [], dragstart: [event: DragEvent], dragend: [] }>()
const prefetch = useTaskPrefetch()
const hover = computed(() => prefetch(props.task, props.slug))
</script>

<template>
  <BorderGlow
    :active="Boolean(task.lease)"
    :glow-radius="8"
    class="shrink-0"
  >
    <button
      type="button"
      :aria-pressed="selected"
      :draggable="draggable"
      :class="[
        'flex shrink-0 flex-col gap-1.5 rounded-md border border-default bg-default px-3 py-2.5 text-start text-sm hover:border-accented',
        task.lease && 'border-primary/60',
        selected && 'border-primary ring-1 ring-primary'
      ]"
      v-bind="hover"
      @dragstart="emit('dragstart', $event)"
      @dragend="emit('dragend')"
      @click="emit('open')"
    >
      <span class="flex items-center gap-2 text-xs">
        <span class="shrink-0 font-mono text-muted">{{ task.ref }}</span>
        <span :class="task.priority === 'urgent' ? 'text-error' : task.priority === 'high' ? 'text-warning' : 'text-muted'">{{ PRIORITY[task.priority].label }}</span>
        <TaskTypeBadge :type="task.type" />
        <DesignChangedBadge :design="task.design" />
        <a
          v-if="task.pr?.url"
          :href="task.pr?.url"
          target="_blank"
          rel="noopener"
          class="ms-auto flex items-center gap-0.5 text-muted hover:text-primary"
          @click.stop
        ><UIcon
          name="i-lucide-git-pull-request"
          class="size-3"
        />#{{ task.pr?.number }}</a>
      </span>
      <span class="font-medium text-highlighted">{{ task.title }}</span>
      <span
        v-if="note"
        :class="['text-xs', note.color === 'error' ? 'text-error' : note.color === 'warning' ? 'text-warning' : 'text-muted']"
      >{{ note.text }}</span>
      <span class="flex items-center gap-2 text-xs text-muted">
        <span v-if="epic">{{ epic }}</span>
        <span
          v-if="agent"
          class="ms-auto flex items-center gap-1"
        >
          <AgentAvatar
            :name="agent.name"
            working
            size="xs"
          />
          {{ task.type === 'design' && agent.role === 'designer' ? 'Designer · ' : '' }}{{ agent.name }}
        </span>
      </span>
    </button>
  </BorderGlow>
</template>
