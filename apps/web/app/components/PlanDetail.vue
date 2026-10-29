<script setup lang="ts">
import type { Plan, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'

// The session's latest plan, docked in the flyout (design/plan.md). Each
// revision replaces it here rather than adding another card to the chat.
// `sheet`: in the mobile bottom sheet, where the approve buttons share the width
const props = defineProps<{ plan: Plan, previous: Plan | null, busy: boolean, sheet?: boolean }>()
const emit = defineEmits<{ approve: [to: 'ready' | 'backlog'], close: [] }>()
const flyout = useTaskFlyout()
const live = useLive()
const showDiff = ref(false)

const changeColor = { added: 'success', changed: 'warning', unchanged: 'neutral', removed: 'error' } as const
// Removed tasks only matter to the diff, not to the plan as it stands
const tasks = computed(() => props.plan.tasks.filter(t => t.change !== 'removed'))
const criteria = computed(() => tasks.value.reduce((n, t) => n + t.criteriaCount, 0))
// Removed Drafts are deleted (D10), so only their count is left to show
const changed = computed(() => tasks.value.filter(t => t.change !== 'unchanged'))
const removed = computed(() => props.plan.tasks.length - tasks.value.length)
// Where an approved plan's tasks went: the board, the Backlog, or some of each
const kept = computed(() => tasks.value.filter(t => t.status))
const toBacklog = computed(() => kept.value.length > 0 && kept.value.every(t => t.status === 'backlog'))
// The plan's tasks under each of its epics, in the order the PM gave them.
// A Draft moved to another epic by hand is listed last, under Other tasks.
const groups = computed(() => {
  const planned = new Set(props.plan.epics.map(e => e.id))
  const other = { key: '', id: '', title: 'Other tasks' }
  return [...props.plan.epics, other].map((epic) => {
    const own = tasks.value.filter(t => epic.id ? t.epicId === epic.id : !t.epicId || !planned.has(t.epicId))
    return { ...epic, tasks: own, criteria: own.reduce((n, t) => n + t.criteriaCount, 0) }
  }).filter(g => g.tasks.length > 0)
})

// Each epic shows its tasks as a list or a dependency graph, remembered per epic
const views = useLocalStorage<Record<string, 'list' | 'graph'>>('corral.plan.views', {})
const graphTasks = ref<Record<string, Task[]>>({})
async function loadGraph(epicId: string) {
  try {
    graphTasks.value[epicId] = (await api.epics.get(epicId)).tasks
  } catch {
    // Keep what's shown; the next update retries
  }
}
const shownGraphs = computed(() => groups.value.filter(g => g.id && views.value[g.id] === 'graph').map(g => g.id))
watch([shownGraphs, () => props.plan.id], ([ids]) => ids.forEach(id => void loadGraph(id)), { immediate: true })
onMounted(() => {
  const stop = live.subscribe((event) => {
    if (event.type !== 'task.updated' && event.type !== 'task.created') return
    for (const id of shownGraphs.value) {
      if (event.task.epicId === id || graphTasks.value[id]?.some(t => t.id === event.task.id)) void loadGraph(id)
    }
  })
  onBeforeUnmount(stop)
})

watch(() => props.plan.id, () => {
  showDiff.value = false
})
</script>

<template>
  <section
    :aria-label="`Plan v${props.plan.version}: ${props.plan.title}`"
    class="flex h-full min-h-0 flex-col"
  >
    <header class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4">
      <UButton
        v-if="flyout.canGoBack.value"
        icon="i-lucide-arrow-left"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Back"
        class="-ms-2"
        @click="flyout.back()"
      />
      <UBadge
        :label="`Plan v${props.plan.version}`"
        color="neutral"
        variant="subtle"
        size="sm"
      />
      <UBadge
        :label="props.plan.status === 'approved' ? 'Approved' : props.plan.status === 'superseded' ? 'Superseded' : 'Waiting for approval'"
        :color="props.plan.status === 'approved' ? 'success' : props.plan.status === 'superseded' ? 'neutral' : 'primary'"
        variant="subtle"
        size="sm"
      />
      <UButton
        icon="i-lucide-x"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Close"
        class="ms-auto"
        @click="emit('close')"
      />
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="px-4 pt-4 pb-2">
        <h2 class="text-lg font-semibold">
          {{ props.plan.title }}
        </h2>
        <p class="text-xs text-muted">
          <template v-if="groups.length > 1">
            {{ groups.length }} epics ·
          </template>{{ tasks.length }} tasks · {{ criteria }} criteria
        </p>
      </div>
      <section
        v-for="group in groups"
        :key="group.id"
        :aria-label="`Epic ${group.title}`"
        class="border-t border-default px-4 pt-3 pb-4"
      >
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-medium">
              <button
                v-if="group.id"
                type="button"
                class="text-start hover:text-primary hover:underline"
                :aria-label="`Open epic ${group.title}`"
                @click="flyout.openEpic(group.id)"
              >
                {{ group.title }}
              </button>
              <template v-else>
                {{ group.title }}
              </template>
            </h3>
            <p class="text-xs text-muted">
              {{ group.tasks.length }} tasks · {{ group.criteria }} criteria
            </p>
          </div>
          <UTabs
            v-if="group.id"
            :model-value="views[group.id] ?? 'list'"
            :items="[{ label: 'List', value: 'list', icon: 'i-lucide-list' }, { label: 'Graph', value: 'graph', icon: 'i-lucide-network' }]"
            variant="link"
            size="xs"
            :content="false"
            :aria-label="`Show ${group.title} as`"
            @update:model-value="views[group.id] = $event as 'list' | 'graph'"
          />
        </div>
        <ul
          v-if="!group.id || (views[group.id] ?? 'list') === 'list'"
          class="mt-2 divide-y divide-default overflow-hidden rounded-lg border border-default"
        >
          <li
            v-for="task in group.tasks"
            :key="task.key"
          >
            <button
              type="button"
              :disabled="!task.ref"
              class="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-elevated disabled:cursor-default disabled:hover:bg-transparent"
              @click="task.ref && flyout.open(task.ref)"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate">
                  <span
                    v-if="task.ref"
                    class="me-1 font-mono text-xs text-muted"
                  >{{ task.ref }}</span>{{ task.title }}
                </span>
                <span class="block text-xs text-muted">
                  {{ task.criteriaCount }} criteria<span v-if="task.dependsOn.length"> · after {{ task.dependsOn.join(', ') }}</span>
                </span>
              </span>
              <UBadge
                :label="task.revises ? 'Revised' : 'New'"
                :color="task.revises ? 'warning' : 'success'"
                variant="subtle"
                size="xs"
                class="shrink-0"
              />
              <UIcon
                v-if="task.ref"
                name="i-lucide-chevron-right"
                class="size-4 shrink-0 text-dimmed"
              />
            </button>
          </li>
        </ul>
        <div
          v-else
          :aria-label="`Dependency graph of ${group.title}`"
          class="mt-2 h-80 overflow-hidden rounded-lg border border-default"
        >
          <EpicGraph
            v-if="graphTasks[group.id]"
            :tasks="graphTasks[group.id]!"
            direction="down"
            @open="flyout.open($event)"
          />
          <USkeleton
            v-else
            class="size-full"
          />
        </div>
      </section>
      <div
        v-if="props.previous"
        class="border-t border-default px-4 py-3"
      >
        <UButton
          :label="`Changes from v${props.previous.version}`"
          :icon="showDiff ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          variant="link"
          color="neutral"
          size="sm"
          class="px-0"
          :aria-expanded="showDiff"
          @click="showDiff = !showDiff"
        />
        <p
          v-if="showDiff && changed.length === 0 && removed === 0"
          class="text-xs text-muted"
        >
          Nothing changed.
        </p>
        <ul
          v-else-if="showDiff"
          class="flex flex-col gap-1 text-xs"
        >
          <li
            v-if="removed"
            class="text-muted"
          >
            {{ removed }} {{ removed === 1 ? 'task' : 'tasks' }} from v{{ props.previous.version }} removed.
          </li>
          <li
            v-for="task in changed"
            :key="task.key"
            class="flex items-center gap-2"
          >
            <UBadge
              :label="task.revises && task.change === 'added' ? 'Revised' : task.change[0]!.toUpperCase() + task.change.slice(1)"
              :color="changeColor[task.change]"
              variant="subtle"
              size="xs"
              class="w-20 justify-center"
            />
            <span class="truncate">{{ task.title }}</span>
          </li>
        </ul>
      </div>
    </div>

    <footer class="flex shrink-0 flex-col gap-2 border-t border-default p-4 text-sm">
      <template v-if="props.plan.status === 'proposed'">
        <div class="flex flex-wrap gap-2">
          <UButton
            label="Add to board"
            icon="i-lucide-kanban"
            :class="props.sheet && 'flex-1 justify-center'"
            :loading="props.busy"
            @click="emit('approve', 'ready')"
          />
          <UButton
            label="Add to backlog"
            icon="i-lucide-list"
            variant="outline"
            color="neutral"
            :class="props.sheet && 'flex-1 justify-center'"
            :disabled="props.busy"
            @click="emit('approve', 'backlog')"
          />
        </div>
        <span class="text-xs text-muted">New tasks stay Drafts, and revised ones unchanged, until you choose. The board schedules them now; the Backlog keeps them for later or for refining.</span>
      </template>
      <span
        v-else-if="props.plan.status === 'approved'"
        class="text-success"
      >✓ {{ tasks.length }} tasks added to the {{ toBacklog ? 'Backlog' : 'board' }}.</span>
      <span
        v-else
        class="text-muted"
      >Replaced by a later version.</span>
    </footer>
  </section>
</template>
