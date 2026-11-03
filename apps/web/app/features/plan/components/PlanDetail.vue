<script setup lang="ts">
import type { Plan, Task } from '@corral/contracts'
import { approvedPlanSummary } from '@corral/core'
import { useQueries } from '@tanstack/vue-query'
import { epicQuery } from '~/queries/epics'
import { PLAN_STATUS, plural } from '~/utils/labels'
import { currentTasks } from '~/features/plan/utils/plan-versions'
import PlanDetailChanges from '~/features/plan/components/PlanDetailChanges.vue'
import PlanDetailGroup from '~/features/plan/components/PlanDetailGroup.vue'

// The session's latest plan, docked in the flyout (design/plan.md). Each
// revision replaces it here rather than adding another card to the chat.
// `sheet`: in the mobile bottom sheet, where the approve buttons share the width.
// `disabled`: nothing can be approved for now, as while Juno is working.
const props = defineProps<{ plan: Plan, previous: Plan | null, busy: boolean, disabled?: boolean, sheet?: boolean }>()
const emit = defineEmits<{ approve: [to: 'ready' | 'backlog'], close: [] }>()
const flyout = useTaskFlyout()

const tasks = computed(() => currentTasks(props.plan))
// A revised Ready task stays in Ready with either button
const revisesReady = computed(() => tasks.value.some(t => t.revises && t.status === 'ready'))
// The plan's tasks under each of its epics, in the order the PM gave them.
// Tasks without an epic, or a Draft moved to another epic by hand, are
// listed last, under Other tasks (just Tasks when the plan has no epics).
const groups = computed(() => {
  const planned = new Set(props.plan.epics.map(e => e.id))
  const other = { key: '', id: '', title: props.plan.epics.length > 0 ? 'Other tasks' : 'Tasks', dependsOn: [], reviewMode: null }
  return [...props.plan.epics, other].map((epic) => {
    const own = tasks.value.filter(t => epic.id ? t.epicId === epic.id : !t.epicId || !planned.has(t.epicId))
    return { ...epic, tasks: own }
  }).filter(g => g.tasks.length > 0)
})
const epicCount = computed(() => groups.value.filter(g => g.id).length)

// Each epic shows its tasks as a list or a dependency graph, remembered per epic
const views = useLocalStorage<Record<string, 'list' | 'graph'>>('corral.plan.views', {})
const shownGraphs = computed(() => groups.value.filter(g => g.id && views.value[g.id] === 'graph').map(g => g.id))
const graphs = useQueries({ queries: computed(() => shownGraphs.value.map(id => epicQuery(id))) })
const graphTasks = computed<Record<string, Task[]>>(() => Object.fromEntries(graphs.value.flatMap(graph => graph.data ? [[graph.data.id, graph.data.tasks]] : [])))
</script>

<template>
  <section
    :aria-label="`Plan v${props.plan.version}: ${props.plan.title}`"
    class="flex h-full min-h-0 flex-col"
  >
    <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
      <AppButton
        v-if="flyout.canGoBack.value"
        icon="i-hugeicons-arrow-left-02"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Back"
        class="-ms-2"
        @click="flyout.back()"
      />
      <AppBadge
        :label="`Plan v${props.plan.version}`"
        color="neutral"
        variant="subtle"
        size="sm"
      />
      <AppBadge
        :label="PLAN_STATUS[props.plan.status].label"
        :color="PLAN_STATUS[props.plan.status].color"
        variant="subtle"
        size="sm"
      />
      <AppButton
        icon="i-hugeicons-cancel-01"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Close"
        class="ms-auto"
        @click="emit('close')"
      />
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div class="px-4 pt-4 pb-2">
        <h2 class="text-lg font-semibold">
          {{ props.plan.title }}
        </h2>
        <p class="text-xs text-muted-foreground">
          <template v-if="epicCount > 0">
            {{ plural(epicCount, 'epic') }} ·
          </template>{{ plural(tasks.length, 'task') }}
        </p>
      </div>
      <PlanDetailGroup
        v-for="group in groups"
        :key="group.id"
        :group="group"
        :view="views[group.id] ?? 'list'"
        :graph-tasks="graphTasks[group.id]"
        @update:view="views[group.id] = $event"
      />
      <PlanDetailChanges
        v-if="props.previous"
        :plan="props.plan"
        :previous="props.previous"
      />
    </div>

    <footer class="flex shrink-0 flex-col gap-2 border-t border-border p-4 text-sm">
      <template v-if="props.plan.status === 'proposed'">
        <div class="flex flex-wrap gap-2">
          <AppButton
            label="Add to board"
            icon="i-hugeicons-kanban"
            :class="props.sheet && 'flex-1 justify-center'"
            :loading="props.busy"
            :disabled="props.disabled"
            @click="emit('approve', 'ready')"
          />
          <AppButton
            label="Add to backlog"
            icon="i-hugeicons-left-to-right-list-bullet"
            variant="outline"
            color="neutral"
            :class="props.sheet && 'flex-1 justify-center'"
            :disabled="props.busy || props.disabled"
            @click="emit('approve', 'backlog')"
          />
        </div>
        <span class="text-xs text-muted-foreground">New tasks stay Drafts, and revised ones unchanged, until you choose. The board schedules them now; the Backlog keeps them for later or for refining.<template v-if="revisesReady"> A revised Ready task stays in Ready either way.</template></span>
      </template>
      <span
        v-else-if="props.plan.status === 'approved'"
        class="text-success"
      >✓ {{ approvedPlanSummary(props.plan.tasks) }}.</span>
      <span
        v-else
        class="text-muted-foreground"
      >Replaced by a later version.</span>
    </footer>
  </section>
</template>
