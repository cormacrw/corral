<script setup lang="ts">
import type { Backlog } from '~/features/board/composables/useBacklog'
import { moveGroupLabel, movableRows, priorityText } from '~/features/board/utils/backlog'
import { PRIORITY } from '~/utils/labels'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// The Backlog on the web (design/backlog.md): rows open the task flyout
const props = defineProps<{ backlog: Backlog }>()
const { slug, search, showCompleted, collapsed, groups, summary, planTo, pmName, inPlan, toggle, setAll, moving, moveToBoard, moveEpic, creating, newTask, loading, error, refetch } = props.backlog
const flyout = useTaskFlyout()
const prefetch = useTaskPrefetch()
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <ProjectToolbar>
      <AppInput
        v-model="search"
        placeholder="Search Backlog"
        icon="i-hugeicons-search-01"
        size="sm"
        class="w-60"
      />
      <span class="text-sm text-muted-foreground">{{ summary }}</span>
      <AppCheckbox
        v-model="showCompleted"
        label="Show completed"
      />
      <div class="ms-auto flex gap-2">
        <AppButton
          label="Collapse all"
          variant="outline"
          color="neutral"
          size="sm"
          @click="setAll(true)"
        />
        <AppButton
          label="Expand all"
          variant="outline"
          color="neutral"
          size="sm"
          @click="setAll(false)"
        />
        <AppButton
          label="New task"
          icon="i-hugeicons-add-01"
          size="sm"
          :loading="creating"
          @click="newTask"
        />
      </div>
    </ProjectToolbar>

    <AppLoadError
      v-if="error"
      :title="error"
      :retry="refetch"
      class="m-4"
    />
    <div
      v-else-if="loading"
      class="flex flex-col gap-3 p-4"
    >
      <UiSkeleton class="h-32 w-full" />
      <UiSkeleton class="h-32 w-full" />
    </div>
    <div
      v-else
      class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4"
    >
      <section
        v-for="group in groups"
        :key="group.id"
        class="rounded-lg border border-border"
      >
        <header class="flex flex-wrap items-center gap-2 rounded-t-lg bg-muted/50 px-3 py-2 text-sm">
          <BacklogGroupHeading
            :group="group"
            :collapsed="Boolean(collapsed[group.id])"
            @toggle="toggle(group.id)"
          />
          <AppButton
            v-if="group.id !== 'none'"
            label="Parent details"
            icon="i-hugeicons-hierarchy"
            variant="link"
            color="neutral"
            size="xs"
            :aria-pressed="flyout.epic.value === group.id"
            @click="flyout.toggleEpic(group.id)"
          />
          <AppButton
            :to="planTo"
            :label="`Plan with ${pmName}`"
            variant="link"
            size="xs"
            class="ms-auto"
          />
          <AppButton
            v-if="movableRows(group).length > 0"
            :label="moveGroupLabel(group)"
            icon="i-hugeicons-kanban"
            variant="outline"
            color="neutral"
            size="xs"
            :loading="group.rows.some(t => moving.has(t.id))"
            @click="moveEpic(group)"
          />
        </header>
        <ul v-if="!collapsed[group.id]">
          <li
            v-for="task in group.rows"
            :key="task.id"
            :class="['group flex items-center border-t border-border pe-2 hover:bg-muted', flyout.ref.value === task.ref && 'bg-muted']"
          >
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-start text-sm"
              :aria-pressed="flyout.ref.value === task.ref"
              v-bind="prefetch(task, slug)"
              @click="flyout.toggle(task.ref)"
            >
              <span class="w-14 shrink-0 font-mono text-xs text-muted-foreground">{{ task.ref }}</span>
              <TaskTypeBadge :type="task.type" />
              <StatusBadge :status="task.status" />
              <DesignChangedBadge :design="task.design" />
              <span class="min-w-0 flex-1 truncate">
                {{ task.title }}
                <AppBadge
                  v-if="inPlan(task)"
                  label="In plan"
                  size="xs"
                  variant="subtle"
                  color="primary"
                  class="ms-1"
                />
              </span>
              <span class="hidden w-24 text-xs text-muted-foreground md:inline">{{ task.acceptanceCriteria.length ? `${task.acceptanceCriteria.length} criteria` : 'No criteria' }}</span>
              <span :class="['w-16 text-xs', priorityText(task)]">{{ PRIORITY[task.priority].label }}</span>
              <span class="hidden w-16 text-end text-xs text-muted-foreground/70 md:inline"><TimeAgo :at="task.createdAt" /></span>
            </button>
            <AppButton
              v-if="task.status === 'backlog'"
              label="Move to board"
              icon="i-hugeicons-kanban"
              variant="ghost"
              color="neutral"
              size="xs"
              :loading="moving.has(task.id)"
              :aria-label="`Move ${task.ref} to board`"
              class="shrink-0 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
              @click="moveToBoard([task])"
            />
          </li>
        </ul>
      </section>
      <p
        v-if="groups.length === 0"
        class="text-sm text-muted-foreground"
      >
        Nothing in the Backlog. Plan something with {{ pmName }} or add a task.
      </p>
    </div>
  </div>
</template>
