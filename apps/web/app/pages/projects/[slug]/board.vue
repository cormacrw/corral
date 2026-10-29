<script setup lang="ts">
import type { Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'
import { BOARD_COLUMNS, onBoard, sortColumn } from '~/utils/board'
import { epicTitle, PRIORITY, STATUS, taskNote } from '~/utils/labels'

// The board (design/board.md): approved work by status, no drag and drop
const route = useRoute()
const live = useLive()
const flyout = useTaskFlyout()
const device = useDevice()
const slug = computed(() => String(route.params.slug))
const project = computed(() => live.state.value.projects.find(p => p.slug === slug.value) ?? null)
const all = computed<Task[]>(() => project.value ? live.state.value.tasks[project.value.id] ?? [] : [])
const loading = computed(() => Boolean(project.value) && !live.state.value.tasks[project.value!.id])
const error = ref<string | null>(null)
useSeoMeta({ title: () => `Board · ${project.value?.name ?? ''} · Corral` })

watch(project, async (p) => {
  if (p && !live.state.value.tasks[p.id]) {
    try {
      await live.loadTasks(p)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }
}, { immediate: true })

const search = ref('')
const epic = ref<string | null>(null)
const epics = computed(() => [...new Set(all.value.map(t => t.epicId).filter((id): id is string => Boolean(id)))])
const visible = computed(() => all.value.filter(t => onBoard(t)
  && (!epic.value || t.epicId === epic.value)
  && (!search.value || `${t.ref} ${t.title}`.toLowerCase().includes(search.value.toLowerCase()))))

const columns = BOARD_COLUMNS
const DOT = { neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-error', success: 'bg-success', secondary: 'bg-secondary' } as const
const inColumn = (column: { key: string, statuses: TaskStatus[] }) => sortColumn(column.key, visible.value.filter(t => column.statuses.includes(t.status)))
const mobileColumns = computed(() => columns.map(c => ({ ...c, color: DOT[STATUS[c.statuses[0]!].color], tasks: inColumn(c) })))
const agentFor = (task: Task) => task.lease ? live.state.value.agents.find(a => a.role === task.lease!.role) : null
const epicLabel = (id: string) => epicTitle(live.state.value.epics[project.value?.id ?? ''], id, epics.value.indexOf(id))
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <!-- Phones get one column at a time (design/mobile.md) -->
    <BoardMobile
      v-if="device.isMobile.value"
      v-model:search="search"
      v-model:epic="epic"
      :columns="mobileColumns"
      :epics="epics.map(id => ({ id, label: epicLabel(id) }))"
      :total="visible.length"
      :all="all"
      :review-round-cap="project?.reviewRoundCap ?? 5"
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
          <div
            role="radiogroup"
            aria-label="Epic"
            class="flex flex-wrap gap-1"
          >
            <UButton
              label="All epics"
              size="xs"
              :variant="epic === null ? 'subtle' : 'ghost'"
              :color="epic === null ? 'primary' : 'neutral'"
              role="radio"
              :aria-checked="epic === null"
              @click="epic = null"
            />
            <UButton
              v-for="id in epics"
              :key="id"
              :label="epicLabel(id)"
              size="xs"
              :variant="epic === id ? 'subtle' : 'ghost'"
              :color="epic === id ? 'primary' : 'neutral'"
              role="radio"
              :aria-checked="epic === id"
              @click="epic = id"
            />
          </div>
          <UButton
            v-if="epic"
            label="Epic details"
            icon="i-lucide-network"
            size="xs"
            variant="outline"
            color="neutral"
            :aria-pressed="flyout.epic.value === epic"
            @click="flyout.toggleEpic(epic)"
          />
          <span class="ms-auto text-sm text-muted">{{ visible.length }} tasks</span>
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
          class="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto p-4"
        >
          <section
            v-for="column in columns"
            :key="column.label"
            :aria-label="`${column.label}, ${inColumn(column).length}`"
            class="flex max-h-full w-[272px] shrink-0 flex-col rounded-lg border border-default bg-muted"
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
            <div class="flex min-h-0 flex-col gap-2 overflow-y-auto p-2">
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
                  :class="[
                    'flex shrink-0 flex-col gap-1.5 rounded-md border border-default bg-default px-3 py-2.5 text-start text-sm hover:border-accented',
                    task.lease && 'border-primary/60',
                    flyout.ref.value === task.ref && 'border-primary ring-1 ring-primary'
                  ]"
                  @click="flyout.toggle(task.ref)"
                >
                  <span class="flex items-center gap-2 text-xs">
                    <span class="font-mono text-muted">{{ task.ref }}</span>
                    <span :class="task.priority === 'urgent' ? 'text-error' : task.priority === 'high' ? 'text-warning' : 'text-muted'">{{ PRIORITY[task.priority].label }}</span>
                    <TaskTypeBadge :type="task.type" />
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
                    v-if="taskNote(task, all, project?.reviewRoundCap ?? 5)"
                    :class="['text-xs', taskNote(task, all, project?.reviewRoundCap ?? 5)!.color === 'error' ? 'text-error' : taskNote(task, all, project?.reviewRoundCap ?? 5)!.color === 'warning' ? 'text-warning' : 'text-muted']"
                  >{{ taskNote(task, all, project?.reviewRoundCap ?? 5)!.text }}</span>
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
                      {{ agentFor(task)!.name }}
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
      <TaskFlyout />
    </div>
  </UDashboardPanel>
</template>
