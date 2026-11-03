<script setup lang="ts">
import type { Plan, Task } from '@corral/contracts'
import { EPIC_REVIEW_MODE, plural, PRIORITY, priorityText } from '~/utils/labels'

type PlanGroupView = 'list' | 'graph'

// One epic of a plan, or its tasks without one (no id), as a list or a
// dependency graph. `graphTasks` is what the graph draws, once loaded.
const props = defineProps<{
  group: Pick<Plan['epics'][number], 'id' | 'title' | 'dependsOn'> & { reviewMode: Plan['epics'][number]['reviewMode'] | null, tasks: Plan['tasks'] }
  view: PlanGroupView
  graphTasks?: Task[]
}>()
const emit = defineEmits<{ 'update:view': [view: PlanGroupView] }>()
const flyout = useTaskFlyout()
</script>

<template>
  <section
    :aria-label="`Parent ${props.group.title}`"
    class="border-t border-border px-4 pt-3 pb-4"
  >
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-medium">
          <button
            v-if="props.group.id"
            type="button"
            class="text-start hover:text-brand hover:underline"
            :aria-label="`Open parent ${props.group.title}`"
            @click="flyout.openEpic(props.group.id)"
          >
            {{ props.group.title }}
          </button>
          <template v-else>
            {{ props.group.title }}
          </template>
        </h3>
        <p
          v-if="props.group.dependsOn?.length"
          class="text-xs text-muted-foreground"
        >
          After: {{ props.group.dependsOn.map(e => e.title).join(', ') }}
        </p>
        <p class="text-xs text-muted-foreground">
          {{ plural(props.group.tasks.length, 'task') }}<template v-if="props.group.reviewMode">
            · <span :title="EPIC_REVIEW_MODE[props.group.reviewMode].description">Review: {{ EPIC_REVIEW_MODE[props.group.reviewMode].label }}</span>
          </template>
        </p>
      </div>
      <AppTabs
        v-if="props.group.id"
        :model-value="props.view"
        :items="[{ label: 'List', value: 'list', icon: 'i-ri-list-unordered' }, { label: 'Graph', value: 'graph', icon: 'i-ri-node-tree' }]"
        variant="link"
        :content="false"
        :aria-label="`Show ${props.group.title} as`"
        @update:model-value="emit('update:view', $event as PlanGroupView)"
      />
    </div>
    <ul
      v-if="!props.group.id || props.view === 'list'"
      class="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border"
    >
      <li
        v-for="task in props.group.tasks"
        :key="task.key"
      >
        <button
          type="button"
          :disabled="!task.ref"
          class="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
          @click="task.ref && flyout.open(task.ref)"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate">
              <span
                v-if="task.ref"
                class="me-1 font-mono text-xs text-muted-foreground"
              >{{ task.ref }}</span>{{ task.title }}
            </span>
            <span class="block text-xs text-muted-foreground">
              <span :class="priorityText(task)">{{ PRIORITY[task.priority].label }}</span>
              <template v-if="task.humanReview">
                · <Icon
                  name="i-ri-user-follow-line"
                  class="size-3 align-[-2px]"
                /> Human review
              </template>
              <span v-if="task.dependsOn.length"> · after {{ task.dependsOn.join(', ') }}</span>
            </span>
          </span>
          <AppBadge
            :label="task.revises ? 'Revised' : 'New'"
            :color="task.revises ? 'warning' : 'success'"
            variant="subtle"
            size="xs"
            class="shrink-0"
          />
          <Icon
            v-if="task.ref"
            name="i-ri-arrow-right-s-line"
            class="size-4 shrink-0 text-muted-foreground/70"
          />
        </button>
      </li>
    </ul>
    <div
      v-else
      :aria-label="`Dependency graph of ${props.group.title}`"
      class="mt-2 h-80 overflow-hidden rounded-lg border border-border"
    >
      <AsyncEpicGraph
        v-if="props.graphTasks"
        :tasks="props.graphTasks"
        direction="down"
        @open="flyout.open($event)"
      />
      <UiSkeleton
        v-else
        class="size-full"
      />
    </div>
  </section>
</template>
