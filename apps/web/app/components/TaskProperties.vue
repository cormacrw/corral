<script setup lang="ts">
import type { Agent, PatchTaskInput, Project, Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'
import { STATUS } from '~/utils/labels'

// The property rows of a task (design/task.md): label/value rows in the
// flyout, label-above-value in the page rail
const props = withDefaults(defineProps<{
  task: Task
  project: Project | null
  statusOptions: { label: string, value: string, status: TaskStatus }[]
  statusEditable: boolean
  priorityOptions: { label: string, value: string }[]
  typeOptions: { label: string, value: string }[]
  developer: Agent | undefined
  reviewer: Agent | undefined
  stacked?: boolean
}>(), { stacked: false })
const emit = defineEmits<{ status: [value: string], patch: [input: PatchTaskInput] }>()

const dotClass = (status: TaskStatus) => ({
  neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-error', success: 'bg-success', secondary: 'bg-secondary'
})[STATUS[status].color]
</script>

<template>
  <template
    v-for="row in [
      { key: 'project', label: 'Project' },
      { key: 'status', label: 'Status' },
      { key: 'priority', label: 'Priority' },
      { key: 'type', label: 'Type' },
      { key: 'developer', label: 'Developer' },
      { key: 'reviewer', label: 'Reviewer' },
      { key: 'humanReview', label: 'Human review' },
      { key: 'branch', label: 'Branch' },
      { key: 'pr', label: 'Pull request' },
      { key: 'round', label: 'Review round' }
    ]"
    :key="row.key"
  >
    <dt :class="['text-muted', props.stacked && 'mt-2 text-xs']">
      {{ row.label }}
    </dt>
    <dd class="min-w-0">
      <span v-if="row.key === 'project'">{{ props.project?.name ?? '' }}</span>

      <UTooltip
        v-else-if="row.key === 'status'"
        text="Set by agents while they work"
        :disabled="props.statusEditable"
      >
        <USelectMenu
          :model-value="'current'"
          :items="props.statusOptions"
          value-key="value"
          :disabled="!props.statusEditable"
          variant="ghost"
          size="sm"
          :search-input="false"
          class="w-full"
          @update:model-value="emit('status', $event as string)"
        >
          <template #leading="{ modelValue }">
            <span
              :class="['size-2 rounded-full', dotClass(props.statusOptions.find(o => o.value === modelValue)?.status ?? props.task.status)]"
              aria-hidden="true"
            />
          </template>
          <template #item-leading="{ item }">
            <span
              :class="['size-2 rounded-full', dotClass(item.status)]"
              aria-hidden="true"
            />
          </template>
        </USelectMenu>
      </UTooltip>

      <USelectMenu
        v-else-if="row.key === 'priority'"
        :model-value="props.task.priority"
        :items="props.priorityOptions"
        value-key="value"
        variant="ghost"
        size="sm"
        :search-input="false"
        class="w-full"
        @update:model-value="emit('patch', { priority: $event as Task['priority'] })"
      />

      <USelectMenu
        v-else-if="row.key === 'type'"
        :model-value="props.task.type"
        :items="props.typeOptions"
        value-key="value"
        variant="ghost"
        size="sm"
        :search-input="false"
        class="w-full"
        @update:model-value="emit('patch', { type: $event as Task['type'] })"
      />

      <span
        v-else-if="row.key === 'developer' || row.key === 'reviewer'"
        class="flex items-center gap-2"
      >
        <AgentAvatar
          v-if="(row.key === 'developer' ? props.developer : props.reviewer)"
          :name="(row.key === 'developer' ? props.developer : props.reviewer)!.name"
          size="xs"
          :working="Boolean(props.task.lease && props.task.lease.role === row.key)"
        />
        <span>{{ (row.key === 'developer' ? props.developer : props.reviewer)?.name ?? `Any available ${row.key}` }}</span>
      </span>

      <USwitch
        v-else-if="row.key === 'humanReview'"
        :model-value="props.task.humanReview"
        size="sm"
        aria-label="Human review"
        @update:model-value="emit('patch', { humanReview: $event })"
      />

      <span
        v-else-if="row.key === 'branch'"
        class="block truncate font-mono text-xs"
      >{{ props.task.branch ?? '—' }}</span>

      <template v-else-if="row.key === 'pr'">
        <a
          v-if="props.task.prUrl"
          :href="props.task.prUrl"
          target="_blank"
          rel="noopener"
          class="text-primary hover:underline"
        >#{{ props.task.prNumber }}</a>
        <span
          v-else
          class="text-muted"
        >Not opened yet</span>
      </template>

      <span v-else-if="row.key === 'round'">{{ props.task.reviewRounds }} of {{ props.project?.reviewRoundCap ?? 5 }}</span>
    </dd>
  </template>
</template>
