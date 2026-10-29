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
  // A Draft has no status, branch, PR or review yet
  draft?: boolean
  // A merged task's properties are shown, not edited
  readonly?: boolean
}>(), { stacked: false, draft: false, readonly: false })
const DRAFT_HIDDEN = ['status', 'branch', 'pr', 'round']
const live = useLive()
const flyout = useTaskFlyout()
const epic = computed(() => props.task.epicId ? live.state.value.epics[props.task.projectId]?.find(e => e.id === props.task.epicId) ?? null : null)
const emit = defineEmits<{ status: [value: string], patch: [input: PatchTaskInput] }>()

const dotClass = (status: TaskStatus) => ({
  neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-error', success: 'bg-success', secondary: 'bg-secondary'
})[STATUS[status].color]
</script>

<template>
  <template
    v-for="row in [
      { key: 'project', label: 'Project' },
      { key: 'epic', label: 'Epic' },
      { key: 'design', label: 'Design' },
      { key: 'status', label: 'Status' },
      { key: 'priority', label: 'Priority' },
      { key: 'type', label: 'Type' },
      { key: 'developer', label: 'Developer' },
      { key: 'reviewer', label: 'Reviewer' },
      { key: 'humanReview', label: 'Human review' },
      { key: 'branch', label: 'Branch' },
      { key: 'pr', label: 'Pull request' },
      { key: 'round', label: 'Review round' }
    ].filter(r => (!props.draft || !DRAFT_HIDDEN.includes(r.key)) && (r.key !== 'design' || props.task.design))"
    :key="row.key"
  >
    <dt :class="['text-muted', props.stacked ? 'mt-2 text-xs' : 'flex min-h-8 items-center']">
      {{ row.label }}
    </dt>
    <dd :class="['min-w-0', !props.stacked && 'flex min-h-8 items-center']">
      <span v-if="row.key === 'project'">{{ props.project?.name ?? '' }}</span>

      <template v-else-if="row.key === 'epic'">
        <!-- The task page has no flyout, so the epic opens as a page there -->
        <NuxtLink
          v-if="props.task.epicId && props.stacked"
          :to="`/epics/${props.task.epicId}`"
          class="block truncate text-primary hover:underline"
        >{{ epic?.title ?? 'Epic' }}</NuxtLink>
        <button
          v-else-if="props.task.epicId"
          type="button"
          class="truncate text-start text-primary hover:underline"
          @click="flyout.openEpic(props.task.epicId)"
        >
          {{ epic?.title ?? 'Epic' }}
        </button>
        <span
          v-else
          class="text-muted"
        >None</span>
      </template>

      <!-- The approved design version a build task builds, and its screens (D20) -->
      <span
        v-else-if="row.key === 'design' && props.task.design"
        class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
      >
        <NuxtLink
          v-if="props.stacked"
          :to="`/tasks/${props.task.design.taskRef}`"
          class="text-primary hover:underline"
        >{{ props.task.design.taskRef }} v{{ props.task.design.version }}</NuxtLink>
        <button
          v-else
          type="button"
          class="text-primary hover:underline"
          @click="flyout.open(props.task.design.taskRef)"
        >
          {{ props.task.design.taskRef }} v{{ props.task.design.version }}
        </button>
        <UBadge
          v-for="screen in props.task.design.screens"
          :key="screen"
          :label="screen"
          color="neutral"
          variant="subtle"
          size="sm"
          class="font-mono"
        />
        <DesignChangedBadge :design="props.task.design" />
      </span>

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
          class="-ms-2.5 w-[calc(100%+0.625rem)]"
          :ui="{ base: 'md:text-sm' }"
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

      <span v-else-if="props.readonly && row.key === 'priority'">{{ props.priorityOptions.find(o => o.value === props.task.priority)?.label }}</span>
      <span v-else-if="props.readonly && row.key === 'type'">{{ props.typeOptions.find(o => o.value === props.task.type)?.label }}</span>
      <span v-else-if="props.readonly && row.key === 'humanReview'">{{ props.task.humanReview ? 'Yes' : 'No' }}</span>

      <USelectMenu
        v-else-if="row.key === 'priority'"
        :model-value="props.task.priority"
        :items="props.priorityOptions"
        value-key="value"
        variant="ghost"
        size="sm"
        :search-input="false"
        class="-ms-2.5 w-[calc(100%+0.625rem)]"
        :ui="{ base: 'md:text-sm' }"
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
        class="-ms-2.5 w-[calc(100%+0.625rem)]"
        :ui="{ base: 'md:text-sm' }"
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
        :disabled="props.task.type === 'design'"
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
        >{{ props.task.type === 'spike' ? 'None: a spike reports findings' : props.task.type === 'design' ? 'None: a design is submitted as versions' : 'Not opened yet' }}</span>
      </template>

      <span v-else-if="row.key === 'round'">{{ props.task.reviewRounds }} of {{ props.project?.reviewRoundCap ?? 5 }}</span>
    </dd>
  </template>
</template>
