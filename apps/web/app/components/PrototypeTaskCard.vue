<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { epicTitle, PRIORITY } from '~/utils/labels'

// COR-154 v2: title, epic, priority and assignee, nothing else. The assignee
// is the developer, except in Agent review where it's the reviewer.
const props = defineProps<{ task: Task, option: string, selected: boolean }>()
defineEmits<{ open: [] }>()
const live = useLive()
const assignee = computed(() => props.task.status === 'agent_review' ? props.task.reviewer : props.task.developer)
const working = computed(() => Boolean(assignee.value) && props.task.lease?.agentId === assignee.value!.id)
const epic = computed(() => props.task.epicId ? epicTitle(live.state.value.epics[props.task.projectId], props.task.epicId, 0) : null)
const priority = computed(() => PRIORITY[props.task.priority].label)
const tone = computed(() => props.task.priority === 'urgent' ? 'text-error' : props.task.priority === 'high' ? 'text-warning' : 'text-muted')
const edge = computed(() => ({ urgent: 'border-s-error', high: 'border-s-warning', medium: 'border-s-accented', low: 'border-s-default' })[props.task.priority])
const bars = computed(() => ({ urgent: 4, high: 3, medium: 2, low: 1 })[props.task.priority])
</script>

<template>
  <BorderGlow
    :active="Boolean(task.lease)"
    :glow-radius="8"
    class="min-w-0 shrink-0"
  >
    <button
      type="button"
      :data-card="task.ref"
      :data-option="option"
      :aria-label="`Open ${task.ref}: ${task.title}`"
      :aria-pressed="selected"
      :class="[
        'flex w-full min-w-0 flex-col rounded-md border bg-default text-start text-sm transition-colors hover:border-accented focus-visible:outline-2 focus-visible:outline-primary',
        selected ? 'border-primary ring-1 ring-primary' : task.lease ? 'border-primary/60' : 'border-default',
        option === 'b' ? 'gap-1 px-2.5 py-2' : 'gap-2 p-3',
        option === 'c' && ['border-s-4', edge]
      ]"
      @click="$emit('open')"
    >
      <!-- Option D: the assignee leads -->
      <span
        v-if="option === 'd'"
        class="flex min-w-0 items-center justify-between gap-2"
      >
        <PrototypeCardAssignee
          :agent="assignee"
          :working="working"
          emphasis
          size="sm"
        />
        <span :class="['shrink-0 text-xs font-medium', tone]">{{ priority }}</span>
      </span>

      <!-- Option E: the epic heads the card -->
      <span
        v-if="option === 'e' && epic"
        class="-mx-3 -mt-1 truncate border-b border-default px-3 pb-2 text-xs font-medium text-muted"
      >{{ epic }}</span>

      <span :class="['break-words font-medium text-highlighted', option === 'e' && 'text-base leading-snug']">{{ task.title }}</span>

      <span
        v-if="epic && (option === 'a' || option === 'd')"
        class="truncate text-xs text-muted"
      >{{ epic }}</span>

      <span
        v-if="option === 'a' || option === 'e'"
        :class="['flex min-w-0 items-center justify-between gap-2 text-xs', option === 'a' && 'mt-1']"
      >
        <span :class="['flex shrink-0 items-center gap-1.5 font-medium', tone]">
          <PrototypePriorityBars
            v-if="option === 'e'"
            :level="bars"
            :class="tone"
          />
          {{ priority }}
        </span>
        <PrototypeCardAssignee
          :agent="assignee"
          :working="working"
        />
      </span>

      <span
        v-if="option === 'b'"
        class="flex min-w-0 items-center gap-2 text-xs text-muted"
      >
        <PrototypePriorityBars
          :level="bars"
          :label="priority"
          :class="tone"
        />
        <span class="min-w-0 flex-1 truncate">{{ epic }}</span>
        <PrototypeCardAssignee
          :agent="assignee"
          :working="working"
          avatar-only
          size="2xs"
        />
      </span>

      <span
        v-if="option === 'c'"
        class="flex min-w-0 items-center justify-between gap-2 text-xs text-muted"
      >
        <span class="sr-only">{{ priority }} priority</span>
        <span class="min-w-0 flex-1 truncate">{{ epic }}</span>
        <PrototypeCardAssignee
          :agent="assignee"
          :working="working"
          class="shrink-0"
        />
      </span>
    </button>
  </BorderGlow>
</template>
