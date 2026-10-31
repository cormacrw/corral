<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { PRIORITY } from '~/utils/labels'

// The Backlog on a phone (design/backlog.md, design/mobile.md): the same epic
// groups as the web page, stacked, with rows that open the task's page. The
// page owns the data and the moves, so both layouts behave the same.
interface Group {
  id: string
  title: string
  rows: Task[]
  merged: number
  total: number
}
defineProps<{
  groups: Group[]
  count: number
  inPlan: (task: Task) => boolean
  moving: Set<string>
  pmName: string
  planTo: string
  loading: boolean
  error: string | null
}>()
const emit = defineEmits<{
  moveTask: [task: Task]
  moveEpic: [group: Group]
  newTask: []
}>()
const showCompleted = defineModel<boolean>('showCompleted', { required: true })
const search = defineModel<string>('search', { required: true })
const collapsed = defineModel<Record<string, boolean>>('collapsed', { required: true })
</script>

<template>
  <div class="*:shrink-0 flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
    <MobilePageHeader>
      <template #actions>
        <UButton
          icon="i-lucide-plus"
          variant="ghost"
          color="neutral"
          aria-label="New task"
          @click="emit('newTask')"
        />
      </template>
    </MobilePageHeader>

    <div class="flex shrink-0 flex-col gap-2 border-b border-default px-4 py-3">
      <UInput
        v-model="search"
        placeholder="Search Backlog"
        icon="i-lucide-search"
        size="lg"
        variant="soft"
        class="w-full"
      />
      <p class="text-xs text-muted">
        {{ count }} tasks · never scheduled until approved
      </p>
      <UCheckbox
        v-model="showCompleted"
        label="Show completed"
      />
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      class="m-4"
    />
    <div
      v-else-if="loading"
      class="flex flex-col gap-3 p-4"
    >
      <USkeleton class="h-40 w-full" />
      <USkeleton class="h-40 w-full" />
    </div>
    <div
      v-else
      class="flex flex-col gap-3 p-4"
    >
      <section
        v-for="group in groups"
        :key="group.id"
        :aria-label="`${group.title}, ${group.rows.length}`"
        class="overflow-hidden rounded-lg border border-default"
      >
        <header class="flex flex-col gap-2 bg-muted px-3 py-2.5 text-sm">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="flex min-w-0 items-center gap-1 font-semibold text-highlighted"
              :aria-expanded="!collapsed[group.id]"
              @click="collapsed = { ...collapsed, [group.id]: !collapsed[group.id] }"
            >
              <UIcon
                name="i-lucide-chevron-right"
                :class="['size-4 shrink-0 transition-transform', !collapsed[group.id] && 'rotate-90']"
              />
              <span class="truncate">{{ group.title }}</span>
            </button>
            <UBadge
              :label="String(group.rows.length)"
              size="xs"
              variant="subtle"
              color="neutral"
            />
            <span class="text-xs text-muted">{{ group.merged }} of {{ group.total }} done</span>
          </div>
          <div
            v-if="!collapsed[group.id]"
            class="grid grid-cols-2 gap-2"
          >
            <UButton
              :to="planTo"
              :label="`Plan with ${pmName}`"
              icon="i-lucide-message-square"
              variant="outline"
              color="neutral"
              block
            />
            <UButton
              v-if="group.rows.some(t => t.status === 'backlog')"
              :label="group.rows.filter(t => t.status === 'backlog').length === 1 ? 'Move to board' : 'Move all to board'"
              icon="i-lucide-kanban"
              variant="outline"
              color="neutral"
              block
              :loading="group.rows.some(t => moving.has(t.id))"
              @click="emit('moveEpic', group)"
            />
          </div>
        </header>
        <ul v-if="!collapsed[group.id]">
          <li
            v-for="task in group.rows"
            :key="task.id"
            class="flex items-center border-t border-default pe-2"
          >
            <NuxtLink
              :to="`/tasks/${task.ref}`"
              class="flex min-w-0 flex-1 flex-col gap-1 px-3 py-3 text-sm active:bg-elevated"
            >
              <span class="flex items-baseline gap-3">
                <span class="shrink-0 font-mono text-xs text-muted">{{ task.ref }}</span>
                <span class="min-w-0 flex-1 text-highlighted">{{ task.title }}</span>
              </span>
              <span class="flex items-center gap-2 text-xs">
                <UBadge
                  v-if="task.status === 'backlog' && inPlan(task)"
                  label="In plan"
                  size="xs"
                  variant="subtle"
                  color="primary"
                />
                <span :class="task.priority === 'urgent' ? 'text-error' : task.priority === 'high' ? 'text-warning' : 'text-muted'">{{ PRIORITY[task.priority].label }}</span>
                <TaskTypeBadge :type="task.type" />
                <StatusBadge :status="task.status" />
                <DesignChangedBadge :design="task.design" />
              </span>
            </NuxtLink>
            <UButton
              v-if="task.status === 'backlog'"
              icon="i-lucide-kanban"
              variant="ghost"
              color="neutral"
              :loading="moving.has(task.id)"
              :aria-label="`Move ${task.ref} to board`"
              class="shrink-0"
              @click="emit('moveTask', task)"
            />
          </li>
        </ul>
      </section>
      <p
        v-if="groups.length === 0"
        class="text-sm text-muted"
      >
        Nothing in the Backlog. Plan something with {{ pmName }} or add a task.
      </p>
    </div>
  </div>
</template>
