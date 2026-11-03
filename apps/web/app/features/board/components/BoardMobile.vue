<script setup lang="ts">
import type { Board } from '~/features/board/composables/useBoard'
import { activeFilterCount, BOARD_VIEW_ITEMS, hasFilters, NO_FILTERS } from '~/features/board/utils/board'
import { plural } from '~/utils/labels'

// The Board on a phone (design/board.md, design/mobile.md): one column at a
// time, picked from a row of tabs or by swiping sideways. Cards open the
// task or epic page. useBoard owns the filtering, so it matches the web Board,
// and the Status filter hides tabs as it hides columns there.
const props = defineProps<{ board: Board }>()
const { all, filters, view, search, columns, total, single, epicLabel, epicOptions, taskAgents, loading, error, refetch } = props.board
const flyout = useTaskFlyout()
const { index, column, select, onTouchStart, onTouchEnd, onTabKey } = useBoardColumnTabs(columns, view)

const filtersOpen = ref(false)
const activeFilters = computed(() => activeFilterCount(filters.value))

const searching = ref(Boolean(search.value))
function toggleSearch() {
  searching.value = !searching.value
  if (!searching.value) search.value = ''
}
</script>

<template>
  <div class="*:shrink-0 flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
    <MobilePageHeader>
      <template #actions>
        <AppButton
          icon="i-hugeicons-search-01"
          variant="ghost"
          color="neutral"
          aria-label="Search tasks"
          :aria-pressed="searching"
          @click="toggleSearch"
        />
        <AppButton
          icon="i-hugeicons-filter-horizontal"
          square
          variant="ghost"
          color="neutral"
          :aria-label="activeFilters ? `Filters, ${activeFilters} active` : 'Filters'"
          :aria-pressed="filtersOpen"
          :aria-expanded="filtersOpen"
          aria-controls="mobile-board-filters"
          class="relative"
          @click="filtersOpen = !filtersOpen"
        >
          <span
            v-if="activeFilters"
            class="absolute end-0.5 top-0.5 size-2 rounded-full bg-primary"
            aria-hidden="true"
            data-testid="board-filter-indicator"
          />
        </AppButton>
      </template>
    </MobilePageHeader>

    <div class="flex shrink-0 flex-col gap-3 border-b border-border pt-3">
      <AppTabs
        v-model="view"
        :items="BOARD_VIEW_ITEMS"
        :content="false"
        class="mx-4 w-auto self-start"
      />
      <AppInput
        v-if="searching"
        v-model="search"
        placeholder="Search tasks"
        icon="i-hugeicons-search-01"
        autofocus
        class="mx-4"
      />
      <div
        v-show="filtersOpen"
        id="mobile-board-filters"
        class="flex flex-wrap items-center gap-2 px-4"
        data-testid="board-filters"
      >
        <BoardFilters
          v-model="filters"
          :epics="epicOptions"
          :agents="taskAgents"
          item-class="w-[calc(50%-0.25rem)]"
        />
        <AppButton
          v-if="hasFilters(filters)"
          label="Clear filters"
          icon="i-hugeicons-cancel-01"
          size="sm"
          variant="ghost"
          color="neutral"
          class="shrink-0"
          @click="filters = { ...NO_FILTERS }"
        />
        <AppButton
          v-if="single"
          label="Parent details"
          icon="i-hugeicons-hierarchy"
          size="sm"
          variant="ghost"
          color="neutral"
          @click="flyout.openEpic(single)"
        />
        <span class="ms-auto text-sm text-muted-foreground">{{ plural(total, 'task') }}</span>
      </div>
      <div
        role="tablist"
        aria-label="Board columns"
        class="flex gap-2 overflow-x-auto overscroll-x-contain px-4 pb-3 [scrollbar-width:none]"
        @keydown="onTabKey"
      >
        <button
          v-for="(c, i) in columns"
          :id="`board-tab-${c.key}`"
          ref="tabs"
          :key="c.key"
          type="button"
          role="tab"
          :aria-selected="i === index"
          aria-controls="board-column"
          :tabindex="i === index ? 0 : -1"
          :class="[
            'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium',
            i === index ? 'border-primary/40 bg-primary/10 text-brand' : 'border-border text-foreground'
          ]"
          @click="select(i)"
        >
          <span
            :class="['size-2 rounded-full', c.color]"
            aria-hidden="true"
          />
          {{ c.label }}
          <span :class="i === index ? 'text-brand' : 'text-muted-foreground'">{{ c.count }}</span>
        </button>
      </div>
    </div>

    <AppLoadError
      v-if="error"
      :title="error"
      :retry="refetch"
      class="m-4"
    />
    <div
      v-else-if="loading"
      class="flex flex-col gap-2 p-4"
    >
      <UiSkeleton
        v-for="i in 3"
        :key="i"
        class="h-24 w-full"
      />
    </div>
    <section
      v-else-if="column"
      id="board-column"
      role="tabpanel"
      :aria-label="`${column.label}, ${column.count}`"
      class="flex flex-1 flex-col bg-muted/40 p-4"
      data-testid="board-column"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <header class="mb-2 flex items-center gap-2 text-sm">
        <span class="font-semibold text-foreground">{{ column.label }}</span>
        <span class="ms-auto text-xs text-muted-foreground">Whose turn: {{ column.hint }}</span>
      </header>
      <div class="flex flex-col gap-2">
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
          <TaskCard
            v-else-if="entry.task"
            :task="entry.task"
            :tasks="all"
            :epic="entry.task.parentTask ? epicLabel(entry.task.epicId!) : null"
            :to="`/tasks/${entry.task.ref}`"
          />
        </template>
      </div>
      <p
        v-if="column.count === 0"
        class="py-8 text-center text-sm text-muted-foreground/70"
      >
        Nothing here
      </p>
    </section>
  </div>
</template>
