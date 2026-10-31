<script setup lang="ts">
import type { Epic, Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'
import type { BoardFilters } from '~/utils/board'
import { boardColumnKey, swipeStep } from '~/utils/board'
import { PRIORITY, taskNote } from '~/utils/labels'

// The Board on a phone (design/board.md, design/mobile.md): one column at a
// time, picked from a row of tabs or by swiping sideways. Cards open the
// task's page. The page owns the filtering, so it matches the web Board,
// and the Status filter hides tabs as it hides columns there.
const props = defineProps<{
  columns: { key: string, label: string, statuses: TaskStatus[], hint: string, color: string, tasks: Task[] }[]
  epics: { id: string, label: string }[]
  boardEpics: Epic[]
  agents: { id: string, name: string }[]
  total: number
  all: Task[]
  reviewRoundCap: number
  loading: boolean
  error: string | null
}>()
const search = defineModel<string>('search', { required: true })
const filters = defineModel<BoardFilters>('filters', { required: true })

const live = useLive()
const route = useRoute()
const router = useRouter()

// The open column lives in ?column= so Back from a task returns to it
const index = computed(() => Math.max(0, props.columns.findIndex(c => c.key === boardColumnKey(route.query.column))))
const column = computed(() => props.columns[index.value]!)
function select(i: number) {
  const next = props.columns[Math.min(props.columns.length - 1, Math.max(0, i))]!
  if (next.key !== column.value.key) void router.replace({ query: { ...route.query, column: next.key } })
}

// Keep the open tab in view as it changes
const tabs = useTemplateRef<HTMLElement[]>('tabs')
async function scrollTab(i: number) {
  await nextTick()
  tabs.value?.[i]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
}
watch(index, scrollTab)
onMounted(() => void scrollTab(index.value))

let start: { x: number, y: number } | null = null
function onTouchStart(event: TouchEvent) {
  const touch = event.touches[0]
  start = touch ? { x: touch.clientX, y: touch.clientY } : null
}
function onTouchEnd(event: TouchEvent) {
  const touch = event.changedTouches[0]
  if (!start || !touch) return
  const step = swipeStep(touch.clientX - start.x, touch.clientY - start.y)
  start = null
  if (step) select(index.value + step)
}
function onTabKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  event.preventDefault()
  select(index.value + step)
  void nextTick(() => tabs.value?.[index.value]?.focus())
}

const filtersOpen = ref(false)
const activeFilterCount = computed(() => [
  filters.value.epics,
  filters.value.statuses,
  filters.value.priorities,
  filters.value.agents
].filter(values => values.length > 0).length)

const searching = ref(Boolean(search.value))
function toggleSearch() {
  searching.value = !searching.value
  if (!searching.value) search.value = ''
}
const epicLabel = (id: string) => props.epics.find(e => e.id === id)?.label ?? ''
const agentFor = (task: Task) => task.lease ? live.state.value.agents.find(a => a.id === task.lease!.agentId) : null
const note = (task: Task) => taskNote(task, props.all, props.reviewRoundCap)
</script>

<template>
  <div class="*:shrink-0 flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
    <MobilePageHeader>
      <template #actions>
        <UButton
          icon="i-lucide-search"
          variant="ghost"
          color="neutral"
          aria-label="Search tasks"
          :aria-pressed="searching"
          @click="toggleSearch"
        />
        <UButton
          icon="i-lucide-list-filter"
          square
          variant="ghost"
          color="neutral"
          :aria-label="activeFilterCount ? `Filters, ${activeFilterCount} active` : 'Filters'"
          :aria-pressed="filtersOpen"
          :aria-expanded="filtersOpen"
          aria-controls="mobile-board-filters"
          class="relative"
          @click="filtersOpen = !filtersOpen"
        >
          <span
            v-if="activeFilterCount"
            class="absolute end-0.5 top-0.5 size-2 rounded-full bg-primary"
            aria-hidden="true"
            data-testid="board-filter-indicator"
          />
        </UButton>
      </template>
    </MobilePageHeader>

    <div class="flex shrink-0 flex-col gap-3 border-b border-default pt-3">
      <UInput
        v-if="searching"
        v-model="search"
        placeholder="Search tasks"
        icon="i-lucide-search"
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
          :epics="epics"
          :agents="agents"
          item-class="w-[calc(50%-0.25rem)]"
        />
        <span class="ms-auto text-sm text-muted">{{ total }} tasks</span>
      </div>
      <BoardEpics
        v-if="boardEpics.length"
        :epics="boardEpics"
        class="px-4"
      />
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
            i === index ? 'border-primary/40 bg-primary/10 text-primary' : 'border-default text-default'
          ]"
          @click="select(i)"
        >
          <span
            :class="['size-2 rounded-full', c.color]"
            aria-hidden="true"
          />
          {{ c.label }}
          <span :class="i === index ? 'text-primary' : 'text-muted'">{{ c.tasks.length }}</span>
        </button>
      </div>
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
      class="flex flex-col gap-2 p-4"
    >
      <USkeleton
        v-for="i in 3"
        :key="i"
        class="h-24 w-full"
      />
    </div>
    <section
      v-else
      id="board-column"
      role="tabpanel"
      :aria-label="`${column.label}, ${column.tasks.length}`"
      class="flex flex-1 flex-col bg-muted/40 p-4"
      data-testid="board-column"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <header class="mb-2 flex items-center gap-2 text-sm">
        <span class="font-semibold text-highlighted">{{ column.label }}</span>
        <span class="ms-auto text-xs text-muted">Whose turn: {{ column.hint }}</span>
      </header>
      <ul class="flex flex-col gap-2">
        <li
          v-for="task in column.tasks"
          :key="task.id"
        >
          <BorderGlow
            :active="Boolean(task.lease)"
            :glow-radius="8"
          >
            <NuxtLink
              :to="`/tasks/${task.ref}`"
              :class="[
                'flex flex-col gap-1.5 rounded-md border border-default bg-default px-3 py-2.5 text-sm active:bg-elevated',
                task.lease && 'border-primary/60'
              ]"
            >
              <span class="flex items-center gap-2 text-xs">
                <span class="shrink-0 font-mono text-muted">{{ task.ref }}</span>
                <span :class="task.priority === 'urgent' ? 'text-error' : task.priority === 'high' ? 'text-warning' : 'text-muted'">{{ PRIORITY[task.priority].label }}</span>
                <TaskTypeBadge :type="task.type" />
                <StatusBadge
                  v-if="task.status === 'merged' || task.status === 'approved'"
                  :status="task.status"
                />
                <DesignChangedBadge :design="task.design" />
                <span
                  v-if="task.prNumber"
                  class="ms-auto flex items-center gap-0.5 text-muted"
                ><UIcon
                  name="i-lucide-git-pull-request"
                  class="size-3"
                />#{{ task.prNumber }}</span>
              </span>
              <span class="font-medium text-highlighted">{{ task.title }}</span>
              <span
                v-if="note(task)"
                :class="['text-xs', note(task)!.color === 'error' ? 'text-error' : note(task)!.color === 'warning' ? 'text-warning' : 'text-muted']"
              >{{ note(task)!.text }}</span>
              <span class="flex items-center gap-2 text-xs text-muted">
                <UBadge
                  v-if="task.epicId"
                  :label="epicLabel(task.epicId)"
                  size="sm"
                  variant="outline"
                  color="neutral"
                />
                <span
                  v-if="agentFor(task)"
                  class="ms-auto flex items-center gap-1 font-medium text-default"
                >
                  {{ task.type === 'design' && agentFor(task)!.role === 'designer' ? 'Designer · ' : '' }}{{ agentFor(task)!.name }}
                  <AgentAvatar
                    :name="agentFor(task)!.name"
                    working
                    size="xs"
                  />
                </span>
              </span>
            </NuxtLink>
          </BorderGlow>
        </li>
      </ul>
      <p
        v-if="column.tasks.length === 0"
        class="py-8 text-center text-sm text-dimmed"
      >
        Nothing here
      </p>
    </section>
  </div>
</template>
