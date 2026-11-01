<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query'
import { runsQuery } from '~/queries/runs'
import { moveTask } from '~/queries/tasks'
import type { Task } from '@corral/contracts'
import { DEFAULT_LIMITS, type TaskStatus } from '@corral/core'
import type { BoardFilters, BoardView } from '~/utils/board'
import { BOARD_COLUMNS, boardMove, boardView, EPIC_COLUMNS, epicOnBoard, epicStage, epicWorkingAgents, filtersFromQuery, filtersToQuery, matchesEpicFilter, matchesFilter, onBoard, sortColumn, taskAgentIds, unfinishedPrerequisites } from '~/utils/board'
import { doneRefs, epicTitle, epicWithLiveCounts, plural, STATUS, STATUS_DOT, taskNote } from '~/utils/labels'

// The Board: approved work by status, with human moves through the same
// actions as the Status menu. The server remains authoritative.
const route = useRoute()
const shell = useShell()
const flyout = useTaskFlyout()
const device = useDevice()
const { slug, project, tasks: all, epics: epicList, loading, error, refetch } = useProject()
useSeoMeta({ title: () => `Board · ${project.value?.name ?? ''} · Corral` })

// The filters live in the URL query, so a filtered Board reloads and shares
const router = useRouter()
// They're held here too: the query only updates once the navigation lands,
// so quick changes (picking two options, typing) would otherwise build on a
// stale query and drop one another.
const filters = ref<BoardFilters>(filtersFromQuery(route.query))
// The Tasks / Epics toggle is shared across layouts. ?view= wins over
// the view last used, and the URL's view counts as used.
const lastView = useLocalStorage<BoardView>('corral.board.view', 'tasks')
const view = ref(boardView(route.query.view, boardView(lastView.value, 'tasks')))
watch(view, (next) => {
  lastView.value = next
}, { immediate: true })
const VIEW_ITEMS = [{ label: 'Tasks', value: 'tasks' }, { label: 'Epics', value: 'epics' }]
// The Board filters at once; the URL catches up after a pause in typing, since
// each write is a navigation.
const URL_WRITE_MS = 200
let writing = 0
let urlWrite: ReturnType<typeof setTimeout> | null = null
watch([filters, view], ([next, nextView]) => {
  if (urlWrite) clearTimeout(urlWrite)
  else writing++
  urlWrite = setTimeout(async () => {
    urlWrite = null
    try {
      await router.replace({ query: { ...filtersToQuery(next, route.query), view: nextView } })
    } finally {
      writing--
    }
  }, URL_WRITE_MS)
})
onBeforeUnmount(() => {
  if (urlWrite) clearTimeout(urlWrite)
})
// Back, forward and links change the query from outside
watch(() => route.query, (query) => {
  if (writing) return
  const next = filtersFromQuery(query)
  if (JSON.stringify(next) !== JSON.stringify(filters.value)) filters.value = next
  view.value = boardView(query.view, view.value)
})
const search = computed({
  get: () => filters.value.search,
  set: (value: string) => { filters.value = { ...filters.value, search: value } }
})
const epics = computed(() => [...new Set(all.value.map(t => t.epicId).filter((id): id is string => Boolean(id)))])
// Agents that work on tasks, for the Agent filter
const taskAgents = computed(() => shell.agents.filter(a => a.role !== 'pm'))
const visible = computed(() => all.value.filter(t => onBoard(t) && matchesFilter(t, filters.value, taskAgentIds(t))))
// Epic details opens the epic only when exactly one is selected
const single = computed(() => filters.value.epics.length === 1 ? filters.value.epics[0]! : null)

// The Status filter hides the columns it doesn't select
const columns = computed(() => filters.value.statuses.length > 0 ? BOARD_COLUMNS.filter(c => filters.value.statuses.includes(c.key)) : BOARD_COLUMNS)
const boardColumns = computed(() => columns.value.map(c => ({ ...c, color: STATUS_DOT[STATUS[c.statuses[0]!].color], tasks: sortColumn(c.key, visible.value.filter(t => c.statuses.includes(t.status))) })))
const notes = computed(() => {
  const done = doneRefs(all.value)
  const cap = project.value?.reviewRoundCap ?? DEFAULT_LIMITS.reviewRoundCap
  return new Map(visible.value.map(task => [task.id, taskNote(task, done, cap)]))
})
const agentFor = (task: Task) => task.lease ? shell.agents.find(a => a.id === task.lease!.agentId) ?? null : null
const epicLabel = (id: string) => epicTitle(epicList.value, id, epics.value.indexOf(id))
const epicOptions = computed(() => epics.value.map(id => ({ id, label: epicLabel(id) })))
// Epics with work left or tasks on the Board, so one waiting on its epic PR
// stays here after its tasks leave the Complete column.
const liveEpics = computed(() => epicList.value.map(epic => epicWithLiveCounts(epic, all.value)))
const onBoardEpics = computed(() => liveEpics.value.filter(epic => epicOnBoard(epic, all.value.filter(t => t.epicId === epic.id))))
// The Epics view: one card per epic, each in the one column its stage names
const visibleEpics = computed(() => onBoardEpics.value.filter(epic => matchesEpicFilter(epic, filters.value)))
const activeRuns = useQuery(computed(() => ({ ...runsQuery({ active: true }), enabled: view.value === 'epics' })))
const epicColumns = computed(() => {
  const staged = visibleEpics.value.map((epic) => {
    const stage = epicStage(epic, all.value.filter(t => t.epicId === epic.id && t.status !== 'backlog'))
    return { epic, stage, workingAgents: epicWorkingAgents(epic.id, all.value, activeRuns.data.value ?? [], shell.agents), waitingOn: stage === 'done' ? [] : unfinishedPrerequisites(epic, liveEpics.value) }
  })
  return EPIC_COLUMNS.map(column => ({ ...column, dot: STATUS_DOT[STATUS[column.status].color], cards: staged.filter(card => card.stage === column.key) }))
})

const toast = useToast()
const move = useMutation(moveTask)
const moving = ref(new Set<string>())
const dragged = ref<Task | null>(null)
const canDrag = (task: Task) => BOARD_COLUMNS.some(column => boardMove(task, column.statuses[0]!))
function startDrag(event: DragEvent, task: Task) {
  if (moving.value.has(task.id)) {
    event.preventDefault()
    return
  }
  dragged.value = task
  event.dataTransfer?.setData('text/plain', task.ref)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function allowDrop(event: DragEvent, status: TaskStatus) {
  if (dragged.value && boardMove(dragged.value, status)) {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }
}
async function dropTask(event: DragEvent, status: TaskStatus) {
  event.preventDefault()
  const task = dragged.value
  dragged.value = null
  if (!task || moving.value.has(task.id)) return
  const input = boardMove(task, status)
  if (!input) return
  moving.value.add(task.id)
  try {
    await move.mutateAsync({ task: { ...task, slug: slug.value }, input, status })
  } catch (e) {
    toast.add({ title: `Could not move ${task.ref}`, description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    moving.value.delete(task.id)
  }
}
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <!-- Phones get one column at a time (design/mobile.md) -->
    <BoardMobile
      v-if="device.isMobile.value"
      v-model:search="search"
      v-model:filters="filters"
      v-model:view="view"
      :epic-columns="epicColumns"
      :epic-total="visibleEpics.length"
      :columns="boardColumns"
      :epics="epicOptions"
      :agents="taskAgents"
      :total="visible.length"
      :all="all"
      :review-round-cap="project?.reviewRoundCap ?? DEFAULT_LIMITS.reviewRoundCap"
      :loading="loading"
      :error="error"
      @retry="refetch"
    />
    <div
      v-else
      class="flex h-full min-h-0"
    >
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-default px-4 py-2">
          <UTabs
            v-model="view"
            :items="VIEW_ITEMS"
            :content="false"
            size="xs"
            class="w-auto shrink-0"
          />
          <UInput
            v-model="search"
            :placeholder="view === 'epics' ? 'Search epics' : 'Search tasks'"
            icon="i-lucide-search"
            size="sm"
            class="w-60"
          />
          <BoardFilters
            v-model="filters"
            :epics="epicOptions"
            :agents="taskAgents"
            :epics-only="view === 'epics'"
            size="sm"
            item-class="w-40"
          />
          <UButton
            v-if="single"
            label="Epic details"
            icon="i-lucide-network"
            size="xs"
            variant="outline"
            color="neutral"
            :aria-pressed="flyout.epic.value === single"
            @click="flyout.toggleEpic(single)"
          />
          <span class="ms-auto text-sm text-muted">{{ view === 'epics' ? plural(visibleEpics.length, 'epic') : plural(visible.length, 'task') }}</span>
        </div>

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          class="m-4"
          :actions="[{ label: 'Retry', onClick: refetch }]"
        />
        <div
          v-else-if="loading"
          class="flex gap-3 p-4"
        >
          <USkeleton
            v-for="i in 4"
            :key="i"
            class="h-64 w-[272px]"
          />
        </div>
        <BoardEpicColumns
          v-else-if="view === 'epics'"
          :columns="epicColumns"
        />
        <div
          v-else
          role="region"
          aria-label="Board columns"
          tabindex="0"
          class="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto overscroll-x-contain p-4"
        >
          <section
            v-for="column in boardColumns"
            :key="column.label"
            :aria-label="`${column.label}, ${column.tasks.length}`"
            :class="['flex max-h-full w-[272px] shrink-0 flex-col rounded-lg border bg-muted', dragged && boardMove(dragged, column.statuses[0]!) ? 'border-primary' : 'border-default']"
            @dragover="allowDrop($event, column.statuses[0]!)"
            @drop="dropTask($event, column.statuses[0]!)"
          >
            <BoardColumnHeader
              :label="column.label"
              :hint="column.hint"
              :count="column.tasks.length"
              :dot="column.color"
            />
            <!-- The padding matches the glow radius so the working glow and the
                 selected ring fit inside the list: anything past it counts as
                 overflow and makes the column scroll (and clips the glow) -->
            <div class="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
              <BoardCard
                v-for="task in column.tasks"
                :key="task.id"
                :task="task"
                :selected="flyout.ref.value === task.ref"
                :draggable="!moving.has(task.id) && canDrag(task)"
                :note="notes.get(task.id) ?? null"
                :epic="task.epicId ? epicLabel(task.epicId) : null"
                :agent="agentFor(task)"
                :slug="slug"
                @dragstart="startDrag($event, task)"
                @dragend="dragged = null"
                @open="flyout.toggle(task.ref)"
              />
              <p
                v-if="column.tasks.length === 0"
                class="px-1 pb-2 text-xs text-dimmed"
              >
                Nothing here
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  </UDashboardPanel>
</template>
