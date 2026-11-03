<script setup lang="ts">
import type { Board } from '~/features/board/composables/useBoard'
import { BOARD_VIEW_ITEMS } from '~/features/board/utils/board'
import { plural } from '~/utils/labels'

// The Board on the web (design/board.md): every column side by side, with
// tasks dragged between them
const props = defineProps<{ board: Board }>()
const { slug, all, filters, view, search, columns, total, single, epicLabel, epicOptions, taskAgents, loading, error, refetch } = props.board
const flyout = useTaskFlyout()
const prefetch = useTaskPrefetch()
const { moving, dragged, canDrag, canDrop, startDrag, allowDrop, dropTask } = useBoardDrag()
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <ProjectToolbar>
      <AppTabs
        v-model="view"
        :items="BOARD_VIEW_ITEMS"
        :content="false"
        class="w-auto shrink-0"
      />
      <AppInput
        v-model="search"
        placeholder="Search tasks"
        icon="i-ri-search-line"
        size="sm"
        class="w-60"
      />
      <BoardFilters
        v-model="filters"
        :epics="epicOptions"
        :agents="taskAgents"
        size="sm"
        item-class="w-40"
      />
      <AppButton
        v-if="single"
        label="Parent details"
        icon="i-ri-node-tree"
        size="xs"
        variant="outline"
        color="neutral"
        :aria-pressed="flyout.epic.value === single"
        @click="flyout.toggleEpic(single)"
      />
      <span class="ms-auto text-sm text-muted-foreground">{{ plural(total, 'task') }}</span>
    </ProjectToolbar>

    <AppLoadError
      v-if="error"
      :title="error"
      :retry="refetch"
      class="m-4"
    />
    <div
      v-else-if="loading"
      class="flex gap-3 p-4"
    >
      <UiSkeleton
        v-for="i in 4"
        :key="i"
        class="h-64 w-[272px]"
      />
    </div>
    <div
      v-else
      role="region"
      aria-label="Board columns"
      tabindex="0"
      class="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto overscroll-x-contain p-4"
    >
      <section
        v-for="column in columns"
        :key="column.label"
        :aria-label="`${column.label}, ${column.count}`"
        :class="['flex max-h-full w-[272px] shrink-0 flex-col rounded-lg border bg-muted/50', canDrop(column.statuses[0]!) ? 'border-primary' : 'border-border']"
        @dragover="allowDrop($event, column.statuses[0]!)"
        @drop="dropTask($event, column.statuses[0]!)"
      >
        <BoardColumnHeader
          :label="column.label"
          :hint="column.hint"
          :count="column.count"
          :dot="column.color"
        />
        <!-- The padding matches the glow radius so the working glow and the
             selected ring fit inside the list: anything past it counts as
             overflow and makes the column scroll (and clips the glow) -->
        <div class="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
          <template
            v-for="entry in column.entries"
            :key="entry.card?.epic.id ?? entry.task!.id"
          >
            <BoardEpicCard
              v-if="entry.card"
              :epic="entry.card.epic"
              :waiting-on="entry.card.waitingOn"
              :working-agents="entry.card.workingAgents"
            />
            <div
              v-else-if="entry.task"
              :draggable="!moving.has(entry.task.id) && canDrag(entry.task)"
              class="shrink-0"
              v-bind="prefetch(entry.task, slug)"
              @dragstart="startDrag($event, entry.task!)"
              @dragend="dragged = null"
            >
              <TaskCard
                :task="entry.task"
                :tasks="all"
                :epic="entry.task.parentTask ? epicLabel(entry.task.epicId!) : null"
                :pressed="flyout.ref.value === entry.task.ref"
                @open="flyout.toggle(entry.task!.ref)"
              />
            </div>
          </template>
          <p
            v-if="column.count === 0"
            class="px-1 pb-2 text-xs text-muted-foreground/70"
          >
            Nothing here
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
