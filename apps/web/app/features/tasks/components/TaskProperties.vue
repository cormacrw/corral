<script setup lang="ts">
import type { PatchTaskInput, Project, Task } from '@corral/contracts'
import { DEFAULT_LIMITS, canChangeType, type TaskPriority, type TaskStatus } from '@corral/core'
import { statusOptions as humanStatusOptions, workerRole } from '~/features/tasks/utils/taskDetail'
import { PRIORITY, STATUS, TASK_TYPE } from '~/utils/labels'

// The property rows of a task (design/task.md): label/value rows in the
// flyout, label-above-value in the page rail
const props = withDefaults(defineProps<{
  task: Task
  project: Project | null
  stacked?: boolean
}>(), { stacked: false })
const emit = defineEmits<{ status: [value: string], patch: [input: PatchTaskInput] }>()

const priorityOptions = (Object.keys(PRIORITY) as TaskPriority[]).map(p => ({ label: PRIORITY[p].label, value: p }))
const typeOptions = computed(() => (Object.keys(TASK_TYPE) as Task['type'][])
  .filter(t => canChangeType(props.task, t))
  .map(t => ({ label: TASK_TYPE[t], value: t })))
const statusOptions = computed(() => humanStatusOptions(props.task))
const statusEditable = computed(() => statusOptions.value.length > 1)
// A merged task's properties are shown, not edited
const readonly = computed(() => props.task.status === 'merged')
const selectClass = '-ms-2.5 w-[calc(100%+0.625rem)] md:text-sm'

const dotClass = (status: TaskStatus) => ({
  neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-destructive', success: 'bg-success', secondary: 'bg-secondary'
})[STATUS[status].color]
// Why a task stopped: the card no longer says, so this is where it's read
const hasReason = computed(() => (props.task.status === 'blocked' || props.task.status === 'failed') && Boolean(props.task.statusReason))
// Tasks aren't assigned ahead of time: these are the agents of the task's
// latest runs, or null until one claims it (D15)
const agents = computed(() => ({
  developer: { agent: props.task.developer ?? null, role: workerRole(props.task) },
  reviewer: { agent: props.task.reviewer ?? null, role: 'reviewer' }
}))
const noPr = computed(() => props.task.type === 'spike' ? 'None: a spike reports findings' : props.task.type === 'design' ? 'None: a design is submitted as versions' : 'Not opened yet')

// A Draft has no status, branch, PR or review yet
const DRAFT_HIDDEN = ['status', 'branch', 'pr', 'round']
const rows = computed(() => ([
  { key: 'project', label: 'Project' },
  { key: 'parent', label: 'Parent' },
  { key: 'waitingEpics', label: 'Waiting on:' },
  { key: 'design', label: 'Design' },
  { key: 'status', label: 'Status' },
  { key: 'reason', label: 'Reason' },
  { key: 'priority', label: 'Priority' },
  { key: 'type', label: 'Type' },
  { key: 'developer', label: props.task.type === 'design' ? 'Designer' : 'Developer' },
  { key: 'reviewer', label: 'Reviewer' },
  { key: 'humanReview', label: 'Human review' },
  { key: 'branch', label: 'Branch' },
  { key: 'pr', label: 'Pull request' },
  { key: 'round', label: 'Review round' }
] as const).filter((row) => {
  if (props.task.status === 'draft' && DRAFT_HIDDEN.includes(row.key)) return false
  if (row.key === 'design') return Boolean(props.task.design)
  if (row.key === 'waitingEpics') return props.task.status === 'ready' && props.task.waitingOnEpics.length > 0
  if (row.key === 'reason') return hasReason.value
  return true
}))
</script>

<template>
  <template
    v-for="row in rows"
    :key="row.key"
  >
    <dt :class="['text-muted-foreground', stacked ? 'mt-2 text-xs' : 'flex min-h-8 items-center']">
      {{ row.label }}
    </dt>
    <dd :class="['min-w-0', !stacked && 'flex min-h-8 items-center']">
      <span v-if="row.key === 'project'">{{ project?.name ?? '' }}</span>

      <template v-else-if="row.key === 'parent'">
        <NuxtLink
          v-if="task.parentTask"
          :to="`/tasks/${task.parentTask.ref}`"
          class="block truncate text-brand hover:underline"
        >{{ task.parentTask.title }}</NuxtLink>
        <span
          v-else
          class="text-muted-foreground"
        >None</span>
      </template>

      <span
        v-else-if="row.key === 'waitingEpics'"
        class="space-y-1"
      >
        <NuxtLink
          v-for="dependency in task.waitingOnEpics"
          :key="dependency.id"
          :to="`/epics/${dependency.id}`"
          class="block text-brand hover:underline"
        >{{ dependency.title }}</NuxtLink>
      </span>

      <!-- The approved design version a build task builds, and its screens (D20) -->
      <span
        v-else-if="row.key === 'design' && task.design"
        class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
      >
        <TaskLink :task-ref="task.design.taskRef">
          {{ task.design.taskRef }} v{{ task.design.version }}
        </TaskLink>
        <AppBadge
          v-for="screen in task.design.screens"
          :key="screen"
          :label="screen"
          color="neutral"
          variant="subtle"
          size="sm"
          class="font-mono"
        />
        <DesignChangedBadge :design="task.design" />
      </span>

      <AppTooltip
        v-else-if="row.key === 'status'"
        text="Set by agents while they work"
        :disabled="statusEditable"
      >
        <!-- A disabled button takes no pointer events, so the tooltip hangs on this -->
        <span class="block w-full">
          <AppSelectMenu
            :model-value="'current'"
            :items="statusOptions"
            value-key="value"
            :disabled="!statusEditable"
            inline
            size="sm"
            :search-input="false"
            :class="selectClass"
            @update:model-value="emit('status', $event as string)"
          >
            <template #leading="{ modelValue }">
              <span
                :class="['size-2 rounded-full', dotClass(statusOptions.find(o => o.value === modelValue)?.status ?? task.status)]"
                aria-hidden="true"
              />
            </template>
            <template #item-leading="{ item }">
              <span
                :class="['size-2 rounded-full', dotClass(item.status)]"
                aria-hidden="true"
              />
            </template>
          </AppSelectMenu>
        </span>
      </AppTooltip>

      <span
        v-else-if="row.key === 'reason'"
        class="py-1.5 wrap-anywhere text-destructive"
      >{{ task.statusReason }}</span>

      <span v-else-if="readonly && row.key === 'priority'">{{ priorityOptions.find(o => o.value === task.priority)?.label }}</span>
      <span v-else-if="readonly && row.key === 'type'">{{ typeOptions.find(o => o.value === task.type)?.label }}</span>
      <span v-else-if="readonly && row.key === 'humanReview'">{{ task.humanReview ? 'Yes' : 'No' }}</span>

      <AppSelectMenu
        v-else-if="row.key === 'priority'"
        :model-value="task.priority"
        :items="priorityOptions"
        value-key="value"
        inline
        size="sm"
        :search-input="false"
        :class="selectClass"
        @update:model-value="emit('patch', { priority: $event as Task['priority'] })"
      />

      <AppSelectMenu
        v-else-if="row.key === 'type'"
        :model-value="task.type"
        :disabled="typeOptions.length < 2"
        :items="typeOptions"
        value-key="value"
        inline
        size="sm"
        :search-input="false"
        :class="selectClass"
        @update:model-value="emit('patch', { type: $event as Task['type'] })"
      />

      <span
        v-else-if="row.key === 'developer' || row.key === 'reviewer'"
        class="flex items-center gap-2"
      >
        <AgentAvatar
          v-if="agents[row.key].agent"
          :name="agents[row.key].agent!.name"
          size="xs"
          :working="Boolean(task.lease && task.lease.role === agents[row.key].role)"
        />
        <span>{{ agents[row.key].agent?.name ?? `Any available ${agents[row.key].role}` }}</span>
      </span>

      <AppSwitch
        v-else-if="row.key === 'humanReview'"
        :model-value="task.humanReview"
        :disabled="task.type === 'design'"
        aria-label="Human review"
        @update:model-value="emit('patch', { humanReview: $event })"
      />

      <span
        v-else-if="row.key === 'branch'"
        class="block truncate font-mono text-xs"
      >{{ task.branch ?? '—' }}</span>

      <template v-else-if="row.key === 'pr'">
        <a
          v-if="task.pr?.url"
          :href="task.pr?.url"
          target="_blank"
          rel="noopener"
          class="text-brand hover:underline"
        >#{{ task.pr?.number }}</a>
        <TaskCommitLinks
          v-else-if="task.submission"
          :task="task"
        />
        <span
          v-else
          class="text-muted-foreground"
        >{{ noPr }}</span>
      </template>

      <span v-else-if="row.key === 'round'">{{ task.reviewRounds }} of {{ project?.reviewRoundCap ?? DEFAULT_LIMITS.reviewRoundCap }}</span>
    </dd>
  </template>
</template>
