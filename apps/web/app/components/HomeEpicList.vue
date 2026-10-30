<script setup lang="ts">
import type { Epic, Project, Task } from '@corral/contracts'
import { plural, projectColor, timeAgo } from '~/utils/labels'

const props = defineProps<{ entries: { epic: Epic, project: Project, tasks: Task[] }[], completed?: boolean }>()
const mode = { direct: 'Direct review', epic: 'Epic review', each_task: 'Review each task' }
function detail(epic: Epic, tasks: Task[]) {
  if (epic.reviewState === 'human_review') return `Epic PR #${epic.prNumber} awaits your review`
  const blocked = tasks.filter(t => ['blocked', 'failed'].includes(t.status)).length
  const review = tasks.filter(t => t.status === 'human_review').length
  const flight = tasks.filter(t => ['in_progress', 'agent_review', 'ready_to_merge'].includes(t.status)).length
  return [blocked ? `${blocked} blocked / failed` : null, review ? `${review} to review` : null, flight ? `${flight} in flight` : null].filter(Boolean).join(' · ') || 'Ready for the next task'
}
function completion(tasks: Task[], epic: Epic) {
  const times = tasks.flatMap(t => t.mergedAt ? [Date.parse(t.mergedAt)] : [])
  return new Date(times.length ? Math.max(...times) : Date.parse(epic.updatedAt)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
</script>

<template>
  <div>
    <div
      v-for="{ epic, project, tasks } in props.entries"
      :key="epic.id"
      class="border-b border-default py-2.5 last:border-0"
    >
      <div class="mb-2 flex items-center gap-1.5 text-xs text-muted">
        <span
          class="size-1.5 rounded-full"
          :style="{ background: projectColor(project) }"
          aria-hidden="true"
        />
        {{ project.name }}
        <span class="ms-auto">{{ completed ? `Completed ${completion(tasks, epic)}` : `Updated ${timeAgo(epic.updatedAt)}` }}</span>
      </div>
      <NuxtLink
        v-if="completed"
        :to="`/epics/${epic.id}`"
        class="flex items-center justify-between gap-3 text-sm font-medium text-highlighted"
      >
        <span class="flex items-center gap-2"><UIcon
          name="i-lucide-check"
          class="size-4 text-success"
        />{{ epic.title }}</span>
        <span class="shrink-0 text-xs font-normal text-muted">{{ plural(epic.taskCount, 'task') }}</span>
      </NuxtLink>
      <template v-else>
        <EpicProgressRow
          :id="epic.id"
          :title="epic.title"
          :merged="epic.mergedCount"
          :total="epic.taskCount"
        />
        <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <NuxtLink
            :to="`/epics/${epic.id}`"
            :class="tasks.some(t => ['blocked', 'failed'].includes(t.status)) ? 'text-error' : tasks.some(t => t.status === 'human_review') || epic.reviewState === 'human_review' ? 'text-warning' : 'text-muted'"
          >{{ detail(epic, tasks) }}</NuxtLink>
          <span class="text-muted">{{ mode[epic.reviewMode] }}</span>
        </div>
      </template>
    </div>
    <div
      v-if="!entries.length"
      class="rounded-lg border border-dashed border-default p-8 text-center"
    >
      <UIcon
        :name="completed ? 'i-lucide-history' : 'i-lucide-layers'"
        class="mb-2 size-6 text-dimmed"
      />
      <p class="text-sm font-medium text-highlighted">
        {{ completed ? 'Nothing completed recently' : 'No open epics' }}
      </p>
      <p class="mt-1 text-xs text-muted">
        {{ completed ? 'Epics completed in the last 14 days will appear here.' : 'All caught up. New epics will appear when work is ready.' }}
      </p>
    </div>
  </div>
</template>
