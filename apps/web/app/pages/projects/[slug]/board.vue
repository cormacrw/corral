<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { moveTask } from '~/queries/tasks'
import type { Task } from '@corral/contracts'
import { DEFAULT_LIMITS, type TaskStatus } from '@corral/core'
import type { BoardFilters } from '~/utils/board'
import { BOARD_COLUMNS, boardMove, filtersFromQuery, filtersToQuery, matchesFilter, onBoard, sortColumn, taskAgentIds } from '~/utils/board'
import { epicInProgress, epicTitle, epicWithLiveCounts, PRIORITY, STATUS, taskNote } from '~/utils/labels'

// The Board: approved work by status, with human moves through the same
// actions as the Status menu. The server remains authoritative.
const route = useRoute()
const live = useLive()
const flyout = useTaskFlyout()
const device = useDevice()
const { slug, project, tasks: all, epics: epicList, loading, error } = useProject()
useSeoMeta({ title: () => `Board · ${project.value?.name ?? ''} · Corral` })

// The filters live in the URL query, so a filtered Board reloads and shares
const router = useRouter()
// They're held here too: the query only updates once the navigation lands,
// so quick changes (picking two options, typing) would otherwise build on a
// stale query and drop one another.
const filters = ref<BoardFilters>(filtersFromQuery(route.query))
let writing = 0
watch(filters, async (next) => {
  writing++
  try {
    await router.replace({ query: filtersToQuery(next, route.query) })
  } finally {
    writing--
  }
})
// Back, forward and links change the query from outside
watch(() => route.query, (query) => {
  const next = filtersFromQuery(query)
  if (!writing && JSON.stringify(next) !== JSON.stringify(filters.value)) filters.value = next
})
const search = computed({
  get: () => filters.value.search,
  set: (value: string) => { filters.value = { ...filters.value, search: value } }
})
const epics = computed(() => [...new Set(all.value.map(t => t.epicId).filter((id): id is string => Boolean(id)))])
// Agents that work on tasks, for the Agent filter
const taskAgents = computed(() => live.state.value.agents.filter(a => a.role !== 'pm'))
const visible = computed(() => all.value.filter(t => onBoard(t) && matchesFilter(t, filters.value, taskAgentIds(t))))
// Epic details opens the epic only when exactly one is selected
const single = computed(() => filters.value.epics.length === 1 ? filters.value.epics[0]! : null)

// The Status filter hides the columns it doesn't select
const columns = computed(() => filters.value.statuses.length > 0 ? BOARD_COLUMNS.filter(c => filters.value.statuses.includes(c.key)) : BOARD_COLUMNS)
const DOT = { neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-error', success: 'bg-success', secondary: 'bg-secondary' } as const
const inColumn = (column: { key: string, statuses: TaskStatus[] }) => sortColumn(column.key, visible.value.filter(t => column.statuses.includes(t.status)))
const mobileColumns = computed(() => columns.value.map(c => ({ ...c, color: DOT[STATUS[c.statuses[0]!].color], tasks: inColumn(c) })))
const agentFor = (task: Task) => task.lease ? live.state.value.agents.find(a => a.id === task.lease!.agentId) : null
const epicLabel = (id: string) => epicTitle(epicList.value, id, epics.value.indexOf(id))
const epicOptions = computed(() => epics.value.map(id => ({ id, label: epicLabel(id) })))
// Epics with work left or tasks on the Board, so one waiting on its epic PR
// stays here after its tasks leave the Complete column. The Epic filter applies.
const boardEpics = computed(() => epicList.value
  .map(epic => epicWithLiveCounts(epic, all.value))
  .filter(epic => epicInProgress(epic) || all.value.some(t => t.epicId === epic.id && onBoard(t)))
  .filter(epic => filters.value.epics.length === 0 || filters.value.epics.includes(epic.id)))

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
      :columns="mobileColumns"
      :epics="epicOptions"
      :board-epics="boardEpics"
      :agents="taskAgents"
      :total="visible.length"
      :all="all"
      :review-round-cap="project?.reviewRoundCap ?? DEFAULT_LIMITS.reviewRoundCap"
      :loading="loading"
      :error="error"
    />
    <div
      v-else
      class="flex h-full min-h-0"
    >
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-default px-4 py-2">
          <UInput
            v-model="search"
            placeholder="Search tasks"
            icon="i-lucide-search"
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
          <span class="ms-auto text-sm text-muted">{{ visible.length }} tasks</span>
        </div>

        <BoardEpics
          v-if="boardEpics.length"
          :epics="boardEpics"
          class="border-b border-default px-4 py-2"
        />

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          class="m-4"
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
            :aria-label="`${column.label}, ${inColumn(column).length}`"
            :class="['flex max-h-full w-[272px] shrink-0 flex-col rounded-lg border bg-muted', dragged && boardMove(dragged, column.statuses[0]!) ? 'border-primary' : 'border-default']"
            @dragover="allowDrop($event, column.statuses[0]!)"
            @drop="dropTask($event, column.statuses[0]!)"
          >
            <header class="flex shrink-0 items-center gap-2 px-3 py-2.5 text-sm">
              <span
                :class="['size-2 rounded-full', DOT[STATUS[column.statuses[0]!].color]]"
                aria-hidden="true"
              />
              <span class="font-medium">{{ column.label }}</span>
              <UBadge
                :label="String(inColumn(column).length)"
                size="xs"
                variant="subtle"
                color="neutral"
              />
              <span class="ms-auto text-xs text-muted">{{ column.hint }}</span>
            </header>
            <!-- The padding matches the glow radius so the working glow and the
                 selected ring fit inside the list: anything past it counts as
                 overflow and makes the column scroll (and clips the glow) -->
            <div class="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
              <BorderGlow
                v-for="task in inColumn(column)"
                :key="task.id"
                :active="Boolean(task.lease)"
                :glow-radius="8"
                class="shrink-0"
              >
                <button
                  type="button"
                  :aria-pressed="flyout.ref.value === task.ref"
                  :draggable="!moving.has(task.id) && canDrag(task)"
                  :class="[
                    'flex shrink-0 flex-col gap-1.5 rounded-md border border-default bg-default px-3 py-2.5 text-start text-sm hover:border-accented',
                    task.lease && 'border-primary/60',
                    flyout.ref.value === task.ref && 'border-primary ring-1 ring-primary'
                  ]"
                  @dragstart="startDrag($event, task)"
                  @dragend="dragged = null"
                  @click="flyout.toggle(task.ref)"
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
                    <a
                      v-if="task.prUrl"
                      :href="task.prUrl"
                      target="_blank"
                      rel="noopener"
                      class="ms-auto flex items-center gap-0.5 text-muted hover:text-primary"
                      @click.stop
                    ><UIcon
                      name="i-lucide-git-pull-request"
                      class="size-3"
                    />#{{ task.prNumber }}</a>
                  </span>
                  <span class="font-medium text-highlighted">{{ task.title }}</span>
                  <span
                    v-if="taskNote(task, all, project?.reviewRoundCap ?? DEFAULT_LIMITS.reviewRoundCap)"
                    :class="['text-xs', taskNote(task, all, project?.reviewRoundCap ?? DEFAULT_LIMITS.reviewRoundCap)!.color === 'error' ? 'text-error' : taskNote(task, all, project?.reviewRoundCap ?? DEFAULT_LIMITS.reviewRoundCap)!.color === 'warning' ? 'text-warning' : 'text-muted']"
                  >{{ taskNote(task, all, project?.reviewRoundCap ?? DEFAULT_LIMITS.reviewRoundCap)!.text }}</span>
                  <span class="flex items-center gap-2 text-xs text-muted">
                    <span v-if="task.epicId">{{ epicLabel(task.epicId) }}</span>
                    <span
                      v-if="agentFor(task)"
                      class="ms-auto flex items-center gap-1"
                    >
                      <AgentAvatar
                        :name="agentFor(task)!.name"
                        working
                        size="xs"
                      />
                      {{ task.type === 'design' && agentFor(task)!.role === 'designer' ? 'Designer · ' : '' }}{{ agentFor(task)!.name }}
                    </span>
                  </span>
                </button>
              </BorderGlow>
              <p
                v-if="inColumn(column).length === 0"
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
