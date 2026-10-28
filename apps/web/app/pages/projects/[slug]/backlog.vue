<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { epicTitle, PRIORITY, timeAgo } from '~/utils/labels'

// Backlog (design/backlog.md): proposed tasks grouped by epic
const route = useRoute()
const live = useLive()
const flyout = useTaskFlyout()
const toast = useToast()
const slug = computed(() => String(route.params.slug))
const project = computed(() => live.state.value.projects.find(p => p.slug === slug.value) ?? null)
const all = computed<Task[]>(() => project.value ? live.state.value.tasks[project.value.id] ?? [] : [])
const loading = computed(() => Boolean(project.value) && !live.state.value.tasks[project.value!.id])
const error = ref<string | null>(null)
useSeoMeta({ title: () => `Backlog · ${project.value?.name ?? ''} · Corral` })

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
const collapsed = useLocalStorage<Record<string, boolean>>('corral.backlog.collapsed', {})
const backlog = computed(() => all.value.filter(t => t.status === 'backlog' && (!search.value || `${t.ref} ${t.title}`.toLowerCase().includes(search.value.toLowerCase()))))
const groups = computed(() => {
  const ids = [...new Set(all.value.map(t => t.epicId ?? 'none'))]
  return ids.map((id, i) => ({
    id,
    title: id === 'none' ? 'No epic' : epicTitle(live.state.value.epics[project.value?.id ?? ''], id, i),
    rows: backlog.value.filter(t => (t.epicId ?? 'none') === id),
    merged: all.value.filter(t => (t.epicId ?? 'none') === id && t.status === 'merged').length,
    total: all.value.filter(t => (t.epicId ?? 'none') === id).length
  })).filter(g => g.rows.length > 0)
})
const inPlan = computed(() => new Map(live.state.value.planSessions.filter(s => s.status === 'needs_approval').map(s => [s.projectId, s])))
const setAll = (value: boolean) => {
  collapsed.value = Object.fromEntries(groups.value.map(g => [g.id, value]))
}

async function newTask() {
  if (!project.value) return
  try {
    const task = await api.tasks.create(slug.value, { title: 'New task', type: 'backend', description: null })
    flyout.open(task.ref)
  } catch (e) {
    toast.add({ title: 'Could not create the task', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <div class="flex h-full min-h-0">
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-default px-4 py-2">
          <UInput
            v-model="search"
            placeholder="Search Backlog"
            icon="i-lucide-search"
            size="sm"
            class="w-60"
          />
          <span class="text-sm text-muted">{{ backlog.length }} tasks · never scheduled until approved</span>
          <div class="ms-auto flex gap-2">
            <UButton
              label="Collapse all"
              variant="outline"
              color="neutral"
              size="sm"
              @click="setAll(true)"
            />
            <UButton
              label="Expand all"
              variant="outline"
              color="neutral"
              size="sm"
              @click="setAll(false)"
            />
            <UButton
              label="New task"
              icon="i-lucide-plus"
              size="sm"
              @click="newTask"
            />
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
          class="flex flex-col gap-3 p-4"
        >
          <USkeleton class="h-32 w-full" />
          <USkeleton class="h-32 w-full" />
        </div>
        <div
          v-else
          class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
        >
          <section
            v-for="group in groups"
            :key="group.id"
            class="rounded-lg border border-default"
          >
            <header class="flex items-center gap-2 rounded-t-lg bg-muted px-3 py-2 text-sm">
              <button
                type="button"
                class="flex items-center gap-1 font-medium"
                :aria-expanded="!collapsed[group.id]"
                @click="collapsed = { ...collapsed, [group.id]: !collapsed[group.id] }"
              >
                <UIcon
                  name="i-lucide-chevron-right"
                  :class="['size-4 transition-transform', !collapsed[group.id] && 'rotate-90']"
                />
                {{ group.title }}
              </button>
              <UBadge
                :label="String(group.rows.length)"
                size="xs"
                variant="subtle"
                color="neutral"
              />
              <span class="text-xs text-muted">{{ group.merged }} of {{ group.total }} merged</span>
              <UButton
                v-if="group.id !== 'none'"
                label="Epic details"
                icon="i-lucide-network"
                variant="link"
                color="neutral"
                size="xs"
                :aria-pressed="flyout.epic.value === group.id"
                @click="flyout.toggleEpic(group.id)"
              />
              <UButton
                :to="`/plan?project=${project?.id}`"
                label="Plan with Juno"
                variant="link"
                size="xs"
                class="ms-auto"
              />
            </header>
            <ul v-if="!collapsed[group.id]">
              <li
                v-for="task in group.rows"
                :key="task.id"
                class="border-t border-default"
              >
                <button
                  type="button"
                  :class="['flex w-full items-center gap-3 px-3 py-2 text-start text-sm hover:bg-elevated', flyout.ref.value === task.ref && 'bg-elevated']"
                  :aria-pressed="flyout.ref.value === task.ref"
                  @click="flyout.toggle(task.ref)"
                >
                  <span class="w-14 shrink-0 font-mono text-xs text-muted">{{ task.ref }}</span>
                  <span class="min-w-0 flex-1 truncate">
                    {{ task.title }}
                    <UBadge
                      v-if="inPlan.get(task.projectId)"
                      label="In plan"
                      size="xs"
                      variant="subtle"
                      color="primary"
                      class="ms-1"
                    />
                  </span>
                  <span class="hidden w-24 text-xs text-muted md:inline">{{ task.acceptanceCriteria.length ? `${task.acceptanceCriteria.length} criteria` : 'No criteria' }}</span>
                  <span :class="['w-16 text-xs', task.priority === 'urgent' ? 'text-error' : task.priority === 'high' ? 'text-warning' : 'text-muted']">{{ PRIORITY[task.priority].label }}</span>
                  <span class="hidden w-16 text-end text-xs text-dimmed md:inline">{{ timeAgo(task.createdAt) }}</span>
                </button>
              </li>
            </ul>
          </section>
          <p
            v-if="groups.length === 0"
            class="text-sm text-muted"
          >
            Nothing in the Backlog. Plan something with Juno or add a task.
          </p>
        </div>
      </div>
      <TaskFlyout />
    </div>
  </UDashboardPanel>
</template>
