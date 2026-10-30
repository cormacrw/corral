<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { epicTitle, PRIORITY } from '~/utils/labels'

// COR-154 v4: title, epic, priority and the assignee's face, plus a type icon
// and a blocked icon when they have something to say. The assignee is the
// developer, except in Agent review where it's the reviewer. The card is a div
// so the blocked icon can be a real button; the title button is the keyboard
// way in and its click bubbles to the card.
const props = defineProps<{ task: Task, all: Task[], blockedIcon: string, selected: boolean }>()
defineEmits<{ open: [], openBlocker: [ref: string] }>()
const live = useLive()
const assignee = computed(() => props.task.status === 'agent_review' ? props.task.reviewer : props.task.developer)
const working = computed(() => Boolean(assignee.value) && props.task.lease?.agentId === assignee.value!.id)
const epic = computed(() => props.task.epicId ? epicTitle(live.state.value.epics[props.task.projectId], props.task.epicId, 0) : null)
const tone = computed(() => props.task.priority === 'urgent' ? 'text-error' : props.task.priority === 'high' ? 'text-warning' : 'text-muted')
const TYPE_ICONS = {
  task: null,
  bug: { icon: 'i-lucide-bug', label: 'Bug' },
  spike: { icon: 'i-lucide-flask-conical', label: 'Spike' },
  design: { icon: 'i-lucide-paintbrush', label: 'Design' }
} as const
const type = computed(() => TYPE_ICONS[props.task.type])
// The same rule as the "Waiting on" note: a Ready task with unmerged dependencies
const blockers = computed(() => props.task.status !== 'ready'
  ? []
  : props.task.dependsOn
      .map(ref => props.all.find(t => t.ref === ref))
      .filter((t): t is Task => Boolean(t) && t!.status !== 'merged'))
</script>

<template>
  <BorderGlow
    :active="Boolean(task.lease)"
    :glow-radius="8"
  >
    <div
      :class="[
        'flex w-full min-w-0 shrink-0 cursor-pointer flex-col gap-2 rounded-md border bg-default p-3 text-sm transition-colors hover:border-accented has-[[data-card]:focus-visible]:outline-2 has-[[data-card]:focus-visible]:outline-primary',
        selected ? 'border-primary ring-1 ring-primary' : task.lease ? 'border-primary/60' : 'border-default'
      ]"
      @click="$emit('open')"
    >
      <button
        type="button"
        :data-card="task.ref"
        :aria-label="`Open ${task.ref}: ${task.title}`"
        :aria-pressed="selected"
        class="cursor-pointer break-words text-start font-medium text-highlighted outline-none"
      >
        {{ task.title }}
      </button>
      <span
        v-if="epic"
        class="truncate text-xs text-muted"
      >{{ epic }}</span>
      <span class="mt-1 flex min-h-6 min-w-0 items-center gap-1.5 text-xs">
        <span :class="['me-auto font-medium', tone]">{{ PRIORITY[task.priority].label }}</span>
        <PrototypeCardBlockers
          v-if="blockers.length"
          :blockers="blockers"
          :icon="blockedIcon"
          @open="$emit('openBlocker', $event)"
        />
        <UIcon
          v-if="type"
          :name="type.icon"
          role="img"
          :aria-label="type.label"
          class="size-4 shrink-0 text-muted"
          :title="type.label"
        />
        <PrototypeCardAssignee
          :agent="assignee"
          :working="working"
        />
      </span>
    </div>
  </BorderGlow>
</template>
