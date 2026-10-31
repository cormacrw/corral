<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { createTask, transitionTask } from '~/queries/tasks'
import { isTaskDone } from '@corral/core'
import type { Task } from '@corral/contracts'
import { ApiError } from '~/queries/client'
import { epicTitle, PRIORITY, timeAgo } from '~/utils/labels'

// Backlog (design/backlog.md): proposed tasks grouped by epic
const shell = useShell()
const flyout = useTaskFlyout()
const device = useDevice()
const router = useRouter()
const toast = useToast()
const transition = useMutation(transitionTask)
const create = useMutation(createTask)
const { slug, project, tasks: all, epics: epicList, loading, error } = useProject()
const pmName = computed(() => shell.agents.find(a => a.role === 'pm')?.name ?? 'the PM')
useSeoMeta({ title: () => `Backlog · ${project.value?.name ?? ''} · Corral` })

const search = ref('')
const showCompleted = ref(false)
const collapsed = useLocalStorage<Record<string, boolean>>('corral.backlog.collapsed', {})
const backlog = computed(() => all.value.filter(t => (t.status === 'backlog' || (showCompleted.value && isTaskDone(t))) && (!search.value || `${t.ref} ${t.title}`.toLowerCase().includes(search.value.toLowerCase()))))
const groups = computed(() => {
  const ids = [...new Set(all.value.map(t => t.epicId ?? 'none'))]
  return ids.map((id, i) => ({
    id,
    title: id === 'none' ? 'No epic' : epicTitle(epicList.value, id, i),
    rows: backlog.value.filter(t => (t.epicId ?? 'none') === id),
    merged: all.value.filter(t => (t.epicId ?? 'none') === id && isTaskDone(t)).length,
    total: all.value.filter(t => (t.epicId ?? 'none') === id).length
  })).filter(g => g.rows.length > 0)
})
const inPlan = computed(() => new Map(shell.planSessions.filter(s => s.status === 'needs_approval').map(s => [s.projectId, s])))
const setAll = (value: boolean) => {
  collapsed.value = Object.fromEntries(groups.value.map(g => [g.id, value]))
}

// Backlog → Ready (D10): one task from its row, or every Backlog task in an
// epic at once. Tasks missing what Ready needs stay put and are listed.
const moving = ref(new Set<string>())
async function moveToBoard(tasks: Task[]) {
  const moved: string[] = []
  const notReady: string[] = []
  for (const task of tasks) moving.value.add(task.id)
  for (const task of tasks) {
    try {
      await transition.mutateAsync({ task: { ...task, slug: slug.value }, input: { type: 'approve' } })
      moved.push(task.ref)
    } catch (e) {
      if (e instanceof ApiError && e.body?.code === 'transition_rejected' && e.body.reason.code === 'not_ready') {
        notReady.push(`${task.ref} needs ${e.body.reason.problems.map(p => p.replaceAll('_', ' ')).join(', ')}`)
      } else {
        toast.add({ title: `Could not move ${task.ref}`, description: e instanceof Error ? e.message : String(e), color: 'error' })
      }
    } finally {
      moving.value.delete(task.id)
    }
  }
  if (moved.length > 0) toast.add({ title: moved.length === 1 ? `${moved[0]} moved to the board` : `${moved.length} tasks moved to the board`, color: 'success' })
  if (notReady.length > 0) toast.add({ title: notReady.length === 1 ? 'Not ready yet' : `${notReady.length} tasks not ready yet`, description: notReady.join('; '), color: 'warning' })
}
const confirmEpic = ref<{ title: string, tasks: Task[] } | null>(null)
function moveEpic(group: { id: string, title: string }) {
  const tasks = all.value.filter(t => t.status === 'backlog' && (t.epicId ?? 'none') === group.id)
  if (tasks.length === 1) void moveToBoard(tasks)
  else confirmEpic.value = { title: group.title, tasks }
}

async function newTask() {
  if (!project.value) return
  try {
    const task = await create.mutateAsync({ slug: slug.value, input: { title: 'New task', type: 'task', description: null } })
    // A phone has no room for the flyout, so the task opens on its own page
    if (device.isMobile.value) void router.push(`/tasks/${task.ref}`)
    else flyout.open(task.ref)
  } catch (e) {
    toast.add({ title: 'Could not create the task', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <BacklogMobile
      v-if="device.isMobile.value"
      v-model:search="search"
      v-model:show-completed="showCompleted"
      v-model:collapsed="collapsed"
      :groups="groups"
      :count="backlog.length"
      :in-plan="task => Boolean(inPlan.get(task.projectId))"
      :moving="moving"
      :pm-name="pmName"
      :plan-to="`/plan?project=${project?.id}`"
      :loading="loading"
      :error="error"
      @move-task="moveToBoard([$event])"
      @move-epic="moveEpic"
      @new-task="newTask"
    />
    <div
      v-else
      class="flex h-full min-h-0"
    >
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
          <UCheckbox
            v-model="showCompleted"
            label="Show completed"
          />
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
          class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4"
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
              <span class="text-xs text-muted">{{ group.merged }} of {{ group.total }} done</span>
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
                :label="`Plan with ${pmName}`"
                variant="link"
                size="xs"
                class="ms-auto"
              />
              <UButton
                v-if="group.rows.some(t => t.status === 'backlog')"
                :label="group.rows.filter(t => t.status === 'backlog').length === 1 ? 'Move to board' : 'Move all to board'"
                icon="i-lucide-kanban"
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
                :class="['group flex items-center border-t border-default pe-2 hover:bg-elevated', flyout.ref.value === task.ref && 'bg-elevated']"
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-start text-sm"
                  :aria-pressed="flyout.ref.value === task.ref"
                  @click="flyout.toggle(task.ref)"
                >
                  <span class="w-14 shrink-0 font-mono text-xs text-muted">{{ task.ref }}</span>
                  <TaskTypeBadge :type="task.type" />
                  <StatusBadge :status="task.status" />
                  <DesignChangedBadge :design="task.design" />
                  <span class="min-w-0 flex-1 truncate">
                    {{ task.title }}
                    <UBadge
                      v-if="task.status === 'backlog' && inPlan.get(task.projectId)"
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
                <UButton
                  v-if="task.status === 'backlog'"
                  label="Move to board"
                  icon="i-lucide-kanban"
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
            class="text-sm text-muted"
          >
            Nothing in the Backlog. Plan something with {{ pmName }} or add a task.
          </p>
        </div>
      </div>
    </div>
    <UModal
      :open="Boolean(confirmEpic)"
      :title="`Move ${confirmEpic?.tasks.length} tasks to the board?`"
      :description="`Every Backlog task in ${confirmEpic?.title} becomes Ready, and agents start on them in dependency order. Tasks missing a description or acceptance criteria stay in the Backlog.`"
      @update:open="confirmEpic = $event ? confirmEpic : null"
    >
      <template #footer>
        <UButton
          label="Cancel"
          variant="outline"
          color="neutral"
          @click="confirmEpic = null"
        />
        <UButton
          label="Move to board"
          icon="i-lucide-kanban"
          @click="moveToBoard(confirmEpic!.tasks); confirmEpic = null"
        />
      </template>
    </UModal>
  </UDashboardPanel>
</template>
