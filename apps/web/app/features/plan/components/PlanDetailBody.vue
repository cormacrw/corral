<script setup lang="ts">
import type { Plan, Task } from '@corral/contracts'
import { useQueries } from '@tanstack/vue-query'
import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'
import { epicQuery } from '~/queries/epics'
import { plural } from '~/utils/labels'
import { currentTasks } from '~/features/plan/utils/plan-versions'
import PlanDetailChanges from '~/features/plan/components/PlanDetailChanges.vue'
import PlanDetailGroup from '~/features/plan/components/PlanDetailGroup.vue'

// A plan's content: its title and counts, its tasks under each epic, and what
// changed since the previous version. The plan flyout and a Plan thread in the
// Inbox both show it. The default slot goes under the counts, as a summary;
// `title` replaces the heading, for a pane whose own heading says it.
const props = defineProps<{ plan: Plan, previous: Plan | null }>()

const tasks = computed(() => currentTasks(props.plan))
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
  <div>
    <div class="flex flex-col gap-1 px-4 pt-4 pb-3">
      <slot name="title">
        <h2 class="text-lg font-semibold">
          {{ props.plan.title }}
        </h2>
      </slot>
      <p class="text-xs text-muted-foreground">
        <template v-if="epicCount > 0">
          {{ plural(epicCount, 'epic') }} ·
        </template>{{ plural(tasks.length, 'task') }}
      </p>
      <slot />
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
</template>
