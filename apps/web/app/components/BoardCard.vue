<script setup lang="ts">
import type { Agent, Task } from '@corral/contracts'
import { PRIORITY } from '~/utils/labels'
import type { taskNote } from '~/utils/labels'

// One card on the Board. Its own component, so opening a task updates the two
// cards that changed rather than the whole Board. On a phone (`mobile`) it's a
// link to the task's page and the PR number isn't a link (design/board.md).
const props = defineProps<{
  task: Task
  selected?: boolean
  draggable?: boolean
  note: ReturnType<typeof taskNote>
  epic: string | null
  agent: Agent | null
  slug?: string
  mobile?: boolean
}>()
const emit = defineEmits<{ open: [], dragstart: [event: DragEvent], dragend: [] }>()
const prefetch = useTaskPrefetch()
const hover = computed(() => props.mobile ? undefined : prefetch(props.task, props.slug ?? ''))
const NuxtLink = resolveComponent('NuxtLink')
const designer = computed(() => props.task.type === 'design' && props.agent?.role === 'designer' ? 'Designer · ' : '')
// A link can't sit in a button: it's laid over the card, in room kept for it
const prLink = computed(() => !props.mobile && Boolean(props.task.pr?.url))
</script>

<template>
  <BorderGlow
    :active="Boolean(task.lease)"
    :glow-radius="8"
    class="shrink-0"
  >
    <div class="relative flex flex-col">
      <component
        :is="mobile ? NuxtLink : 'button'"
        v-bind="mobile ? { to: `/tasks/${task.ref}` } : { 'type': 'button', 'aria-pressed': selected, draggable, ...hover }"
        :class="[
          'flex shrink-0 flex-col gap-1.5 rounded-md border border-default bg-default px-3 py-2.5 text-sm',
          mobile ? 'active:bg-elevated' : 'text-start hover:border-accented',
          task.lease && 'border-primary/60',
          selected && 'border-primary ring-1 ring-primary'
        ]"
        @dragstart="emit('dragstart', $event)"
        @dragend="emit('dragend')"
        @click="!mobile && emit('open')"
      >
        <span :class="['flex flex-wrap items-center gap-x-2 gap-y-1 text-xs', prLink && 'pe-12']">
          <span class="shrink-0 font-mono text-muted">{{ task.ref }}</span>
          <span :class="task.priority === 'urgent' ? 'text-error' : task.priority === 'high' ? 'text-warning' : 'text-muted'">{{ PRIORITY[task.priority].label }}</span>
          <TaskTypeBadge :type="task.type" />
          <StatusBadge
            v-if="task.status === 'merged' || task.status === 'approved'"
            :status="task.status"
          />
          <DesignChangedBadge :design="task.design" />
          <span
            v-if="mobile && task.pr?.number"
            class="ms-auto flex items-center gap-0.5 text-muted"
          ><UIcon
            name="i-lucide-git-pull-request"
            class="size-3"
          />#{{ task.pr?.number }}</span>
        </span>
        <span class="font-medium text-highlighted">{{ task.title }}</span>
        <span
          v-if="note"
          :class="['text-xs', note.color === 'error' ? 'text-error' : note.color === 'warning' ? 'text-warning' : 'text-muted']"
        >{{ note.text }}</span>
        <span class="flex items-center gap-2 text-xs text-muted">
          <UBadge
            v-if="mobile && epic"
            :label="epic"
            size="sm"
            variant="outline"
            color="neutral"
            class="min-w-0"
          />
          <span
            v-else-if="epic"
            class="min-w-0 truncate"
          >{{ epic }}</span>
          <span
            v-if="agent"
            :class="['ms-auto flex shrink-0 items-center gap-1', mobile && 'font-medium text-default']"
          >
            <AgentAvatar
              v-if="!mobile"
              :name="agent.name"
              working
              size="xs"
            />
            {{ designer }}{{ agent.name }}
            <AgentAvatar
              v-if="mobile"
              :name="agent.name"
              working
              size="xs"
            />
          </span>
        </span>
      </component>
      <a
        v-if="prLink"
        :href="task.pr!.url"
        target="_blank"
        rel="noopener"
        class="absolute end-3 top-2.5 flex items-center gap-0.5 text-xs text-muted hover:text-primary"
      ><UIcon
        name="i-lucide-git-pull-request"
        class="size-3"
      />#{{ task.pr?.number }}</a>
    </div>
  </BorderGlow>
</template>
