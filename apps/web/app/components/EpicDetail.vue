<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query'
import { epicHistoryQuery, epicQuery, patchEpic, setEpicDependencies } from '~/queries/epics'
import type { PatchEpicInput } from '@corral/contracts'
import { isTaskDone, type EpicReviewMode } from '@corral/core'
import { ApiError } from '~/queries/client'
import { EPIC_REVIEW_MODE, EPIC_REVIEW_STATE, EPIC_STATUS_TEXT, epicReviewStatus, epicWithLiveCounts, PRIORITY, statusCounts } from '~/utils/labels'

// An epic: its title, description and progress, and the dependency tree of
// its tasks. Docked in the flyout, as a page with room for a big tree, or
// as the mobile screen, where tasks open as pages (design/mobile.md).
const props = defineProps<{ epicId: string, mode: 'flyout' | 'page' | 'mobile' }>()
const emit = defineEmits<{ close: [] }>()

const shell = useShell()
const flyout = useTaskFlyout()
const toast = useToast()
const patchMutation = useMutation(patchEpic)
const dependenciesMutation = useMutation(setEpicDependencies)
const epicResult = useQuery(computed(() => epicQuery(props.epicId)))
const historyResult = useQuery(computed(() => epicHistoryQuery(props.epicId)))
const epic = computed(() => epicResult.data.value ?? null)
const history = computed(() => historyResult.data.value ?? [])
// A failed background refetch leaves what's cached on screen
const error = computed(() => [epicResult, historyResult].find(r => r.isLoadingError.value)?.error.value?.message ?? null)
const saved = ref(false)
const project = computed(() => shell.projects.find(p => p.id === epic.value?.projectId) ?? null)
const { tasks: projectTasks, epics: epicList } = useProjectLists(() => project.value?.slug ?? '')
// Task events update the shared task list, not the epic's aggregate counts.
const related = computed(() => epicList.value.map(e => epicWithLiveCounts(e, projectTasks.value)))
const selectedDependency = ref('')
const savingDependencies = ref(false)
const dependencyError = ref<string | null>(null)
const prerequisites = computed(() => related.value.filter(e => epic.value?.dependsOn.includes(e.id)))
const blockedEpics = computed(() => related.value.filter(e => epic.value?.blocks.includes(e.id)))
const waiting = computed(() => prerequisites.value.filter(e => e.mergedCount < e.taskCount))
const choices = computed(() => related.value.filter(e => e.id !== epic.value?.id && !epic.value?.dependsOn.includes(e.id)).map(e => ({ label: e.title, value: e.id })))

async function setDependencies(ids: string[]) {
  if (!epic.value || savingDependencies.value) return
  savingDependencies.value = true
  dependencyError.value = null
  try {
    await dependenciesMutation.mutateAsync({ id: epic.value.id, dependsOn: ids })
    selectedDependency.value = ''
  } catch (e) {
    dependencyError.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingDependencies.value = false
  }
}
const editingDescription = ref(false)
const descriptionDraft = ref('')
const tab = useLocalStorage<'tasks' | 'graph' | 'activity'>('corral.epic.tab', 'tasks')
let savedTimer: ReturnType<typeof setTimeout> | null = null

watch(() => props.epicId, () => {
  selectedDependency.value = ''
  dependencyError.value = null
  editingDescription.value = false
})

async function patch(input: PatchEpicInput) {
  if (!epic.value) return
  try {
    await patchMutation.mutateAsync({ id: epic.value.id, input })
    saved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      saved.value = false
    }, 1800)
  } catch (e) {
    toast.add({ title: 'Not saved', description: e instanceof ApiError ? e.message : String(e), color: 'error' })
  }
}

function startEditDescription(event?: MouseEvent) {
  // Following a link or selecting text shouldn't open the editor
  if (event && ((event.target as HTMLElement).closest('a') || window.getSelection()?.toString())) return
  descriptionDraft.value = epic.value?.description ?? ''
  editingDescription.value = true
}
async function saveDescription() {
  await patch({ description: descriptionDraft.value.trim() })
  editingDescription.value = false
}

// Progress counts tasks on the board or in the Backlog; Drafts aren't yet
const placed = computed(() => epic.value?.tasks.filter(t => t.status !== 'draft') ?? [])
const merged = computed(() => placed.value.filter(isTaskDone).length)
const drafts = computed(() => (epic.value?.tasks.length ?? 0) - placed.value.length)
const byStatus = computed(() => statusCounts(epic.value?.tasks ?? []))

const reviewModes = Object.entries(EPIC_REVIEW_MODE).map(([value, mode]) => ({ value, label: mode.label }))
const reviewStatus = computed(() => epic.value && epicReviewStatus(epicWithLiveCounts(epic.value, epic.value.tasks)))

// Mobile has no flyout, so a task opens as its own page
const openTask = (ref: string) => props.mode === 'mobile' ? navigateTo(`/tasks/${ref}`) : flyout.open(ref)
const copyLink = () => navigator.clipboard?.writeText(`${location.origin}/epics/${props.epicId}`)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4">
      <template v-if="props.mode === 'flyout'">
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
          label="Epic"
          color="neutral"
          variant="subtle"
          size="sm"
        />
        <span class="truncate text-sm text-muted">{{ project?.name }}</span>
        <span
          v-if="saved"
          class="text-xs text-success"
        >✓ Saved</span>
        <div class="ms-auto flex items-center gap-1">
          <UButton
            icon="i-lucide-link"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Copy link"
            @click="copyLink"
          />
          <UButton
            :to="`/epics/${props.epicId}`"
            icon="i-lucide-maximize-2"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Open full page"
          />
          <UButton
            icon="i-lucide-x"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Close"
            @click="emit('close')"
          />
        </div>
      </template>
      <template v-else-if="props.mode === 'mobile'">
        <UButton
          icon="i-lucide-arrow-left"
          variant="ghost"
          color="neutral"
          aria-label="Back"
          class="-ms-2"
          @click="emit('close')"
        />
        <div class="min-w-0 flex-1 leading-tight">
          <div class="flex items-center gap-1.5 text-xs text-muted">
            <UBadge
              label="Epic"
              color="neutral"
              variant="subtle"
              size="sm"
            />
            <span class="truncate">{{ project?.name }}</span>
          </div>
          <h1 class="flex items-center gap-2 truncate text-base font-semibold text-highlighted">
            {{ epic?.title ?? 'Epic' }}
            <span
              v-if="saved"
              class="text-xs font-normal text-success"
            >✓ Saved</span>
          </h1>
        </div>
        <UButton
          icon="i-lucide-link"
          variant="ghost"
          color="neutral"
          aria-label="Copy link"
          @click="copyLink"
        />
      </template>
      <template v-else>
        <UBreadcrumb :items="[{ label: project?.name ?? 'Project', to: project ? `/projects/${project.slug}` : '/' }, { label: epic?.title ?? 'Epic' }]" />
        <span
          v-if="saved"
          class="ms-2 text-xs text-success"
        >✓ Saved</span>
      </template>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      class="m-4"
      :actions="[{ label: 'Retry', onClick: () => epicResult.refetch() }]"
    />
    <div
      v-else-if="!epic"
      class="flex flex-col gap-3 p-4"
    >
      <USkeleton class="h-6 w-2/3" />
      <USkeleton class="h-16 w-full" />
      <USkeleton class="h-64 w-full" />
    </div>

    <div
      v-else
      :class="['flex min-h-0 flex-1', props.mode === 'page' ? 'max-[900px]:flex-col' : 'flex-col overflow-y-auto overscroll-contain']"
    >
      <div :class="['flex flex-col gap-5 p-4', props.mode === 'page' && 'w-[360px] shrink-0 overflow-y-auto overscroll-contain border-e border-default max-[900px]:w-full max-[900px]:border-e-0']">
        <UAlert
          v-if="waiting.length"
          color="warning"
          variant="subtle"
          :title="`Waiting on ${waiting.map(e => e.title).join(', ')}`"
        />
        <input
          :value="epic.title"
          class="w-full rounded-md bg-transparent px-1 py-0.5 text-lg font-semibold text-highlighted hover:bg-elevated focus:ring-2 focus:ring-primary focus:outline-none"
          aria-label="Epic title"
          @change="patch({ title: ($event.target as HTMLInputElement).value })"
        >

        <p
          class="text-sm text-muted"
          :title="EPIC_REVIEW_MODE[epic.reviewMode].description"
        >
          Review: {{ EPIC_REVIEW_MODE[epic.reviewMode].label }}
        </p>

        <section>
          <h3 class="mb-1 text-xs font-medium text-muted">
            Description
          </h3>
          <template v-if="editingDescription">
            <UTextarea
              v-model="descriptionDraft"
              autoresize
              autofocus
              :rows="5"
              placeholder="What this epic is for, in markdown"
              class="w-full"
              @keydown.esc="editingDescription = false"
            />
            <div class="mt-2 flex justify-end gap-2">
              <UButton
                label="Cancel"
                variant="outline"
                color="neutral"
                size="sm"
                @click="editingDescription = false"
              />
              <UButton
                label="Save"
                size="sm"
                @click="saveDescription"
              />
            </div>
          </template>
          <div
            v-else
            role="button"
            tabindex="0"
            aria-label="Edit description"
            class="-mx-2 cursor-text rounded-md px-2 py-1 text-sm hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            @click="startEditDescription($event)"
            @keydown.enter.self.prevent="startEditDescription()"
          >
            <MarkdownText
              v-if="epic.description"
              :text="epic.description"
            />
            <span
              v-else
              class="text-dimmed"
            >Add a description…</span>
          </div>
        </section>

        <section class="space-y-2">
          <h3 class="text-sm font-medium">
            Review
          </h3>
          <USelect
            :model-value="epic.reviewMode"
            :items="reviewModes"
            :disabled="epic.reviewModeLocked"
            aria-label="Epic review mode"
            :aria-describedby="epic.reviewModeLocked ? 'epic-review-mode-note' : undefined"
            class="w-full"
            @update:model-value="patch({ reviewMode: $event as EpicReviewMode })"
          />
          <p
            v-if="epic.reviewModeLocked"
            id="epic-review-mode-note"
            class="text-xs text-muted"
          >
            Locked because a task in this epic has opened a PR.
          </p>
          <p
            v-else
            class="text-xs text-muted"
          >
            {{ EPIC_REVIEW_MODE[epic.reviewMode].description }}. You can change this until a task opens a PR.
          </p>
          <div
            v-if="epic.prUrl"
            class="flex flex-wrap items-center gap-2 text-sm"
            data-testid="epic-pr"
          >
            <a
              :href="epic.prUrl"
              target="_blank"
              rel="noopener"
              class="text-primary hover:underline"
            >Epic PR #{{ epic.prNumber }}</a>
            <UBadge
              v-if="epic.reviewState"
              :label="EPIC_REVIEW_STATE[epic.reviewState].label"
              :color="EPIC_REVIEW_STATE[epic.reviewState].color"
              variant="subtle"
              size="sm"
            />
          </div>
          <p
            v-else-if="epic.reviewMode !== 'direct'"
            class="text-xs text-muted"
          >
            The epic PR opens once every task is complete.
          </p>
        </section>

        <section class="space-y-3">
          <h3 class="text-sm font-medium">
            Depends on
          </h3>
          <p
            v-if="!prerequisites.length"
            class="text-sm text-muted"
          >
            No dependencies.
          </p>
          <div
            v-for="item in prerequisites"
            :key="item.id"
            class="flex items-center gap-2"
          >
            <NuxtLink
              :to="`/epics/${item.id}`"
              class="min-w-0 flex-1 text-sm text-primary hover:underline"
            >
              {{ item.title }} · {{ item.mergedCount }}/{{ item.taskCount }} done
            </NuxtLink>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              :aria-label="`Remove dependency on ${item.title}`"
              :disabled="savingDependencies"
              @click="setDependencies(epic.dependsOn.filter(id => id !== item.id))"
            />
          </div>
          <div class="flex gap-2">
            <USelect
              v-model="selectedDependency"
              :items="choices"
              placeholder="Choose an epic"
              aria-label="Dependency epic"
              class="min-w-0 flex-1"
              :disabled="savingDependencies"
            />
            <UButton
              label="Add"
              :disabled="!selectedDependency || savingDependencies"
              @click="setDependencies([...epic.dependsOn, selectedDependency])"
            />
          </div>
          <UAlert
            v-if="dependencyError"
            color="error"
            :title="dependencyError"
          />
          <h3 class="text-sm font-medium">
            Blocks
          </h3>
          <p
            v-if="!blockedEpics.length"
            class="text-sm text-muted"
          >
            No blocked epics.
          </p>
          <NuxtLink
            v-for="item in blockedEpics"
            :key="item.id"
            :to="`/epics/${item.id}`"
            class="block text-sm text-primary hover:underline"
          >
            {{ item.title }} · {{ item.mergedCount }}/{{ item.taskCount }} done
          </NuxtLink>
        </section>

        <section>
          <div class="mb-1 flex items-center justify-between text-xs text-muted">
            <span class="font-medium">Progress</span>
            <span>{{ merged }} of {{ placed.length }} done<span v-if="drafts"> · {{ drafts }} draft{{ drafts === 1 ? '' : 's' }}</span></span>
          </div>
          <div
            role="progressbar"
            :aria-label="`${merged} of ${placed.length} tasks done`"
            :aria-valuenow="merged"
            aria-valuemin="0"
            :aria-valuemax="placed.length"
            class="flex h-1.5 overflow-hidden rounded-full bg-accented"
          >
            <span
              class="bg-success"
              :style="{ width: placed.length ? `${(merged / placed.length) * 100}%` : '0' }"
            />
          </div>
          <div class="mt-2 flex flex-wrap gap-1">
            <StatusBadge
              v-for="s in byStatus"
              :key="s.label"
              :status="s.status"
              :label="`${s.label} ${s.count}`"
              size="xs"
            />
          </div>
          <p
            v-if="reviewStatus"
            :class="['mt-2 text-sm font-medium', EPIC_STATUS_TEXT[reviewStatus.color]]"
          >
            {{ reviewStatus.label }}
          </p>
        </section>
      </div>

      <!-- On mobile the tasks follow the details in the one scroll, so the
           list never shrinks into a scroll of its own -->
      <section :class="['flex min-w-0 flex-col', props.mode === 'page' ? 'min-h-0 flex-1 max-[900px]:h-[560px]' : props.mode === 'mobile' ? 'shrink-0 px-4 pb-4' : 'min-h-0 px-4 pb-4']">
        <UTabs
          v-model="tab"
          :items="[{ label: `Tasks (${epic.tasks.length})`, value: 'tasks', icon: 'i-lucide-list' }, { label: 'Graph', value: 'graph', icon: 'i-lucide-network' }, { label: 'Activity', value: 'activity', icon: 'i-lucide-activity' }]"
          :variant="props.mode === 'mobile' ? 'pill' : 'link'"
          :size="props.mode === 'mobile' ? 'md' : 'sm'"
          :content="false"
          :ui="props.mode === 'mobile' ? { indicator: 'bg-default shadow-xs', trigger: 'data-[state=active]:text-highlighted' } : undefined"
          :class="props.mode === 'page' && 'px-4 pt-2'"
        />
        <div
          v-if="tab === 'activity'"
          class="flex min-h-0 flex-col gap-3 overflow-y-auto p-4"
        >
          <AuditActivity
            v-for="entry in history"
            :key="entry.id"
            :entry="entry"
            :text="entry.action === 'epic.updated' ? `edited ${(entry.detail.changed as string[] | undefined)?.join(', ') ?? 'the epic'}` : entry.action"
          />
          <p
            v-if="!history.length"
            class="text-sm text-muted"
          >
            No activity yet.
          </p>
        </div>
        <p
          v-else-if="epic.tasks.length === 0"
          class="p-6 text-center text-sm text-muted"
        >
          No tasks in this epic yet.
        </p>
        <ul
          v-else-if="tab === 'tasks'"
          :class="[props.mode !== 'mobile' && 'min-h-0 overflow-y-auto overscroll-contain', props.mode === 'page' ? 'flex-1 px-4 py-2' : 'mt-2']"
        >
          <li
            v-for="task in epic.tasks"
            :key="task.id"
          >
            <button
              type="button"
              :aria-pressed="flyout.ref.value === task.ref"
              :class="['flex w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-elevated', props.mode === 'mobile' ? 'min-h-11 py-2.5' : 'py-2', flyout.ref.value === task.ref && 'bg-elevated']"
              @click="openTask(task.ref)"
            >
              <span class="w-14 shrink-0 font-mono text-xs text-muted">{{ task.ref }}</span>
              <span class="min-w-0 flex-1 truncate">{{ task.title }}</span>
              <span
                v-if="task.dependsOn.length"
                class="hidden shrink-0 text-xs text-muted sm:inline"
              >after {{ task.dependsOn.join(', ') }}</span>
              <span
                v-if="task.priority === 'urgent' || task.priority === 'high'"
                :class="['shrink-0 text-xs', task.priority === 'urgent' ? 'text-error' : 'text-warning']"
              >{{ PRIORITY[task.priority].label }}</span>
              <StatusBadge
                :status="task.status"
                size="xs"
              />
            </button>
          </li>
        </ul>
        <div
          v-else
          :aria-label="`Dependency graph of ${epic.title}`"
          :class="props.mode === 'page' ? 'min-h-0 flex-1' : 'mt-2 h-[420px] overflow-hidden rounded-lg border border-default'"
        >
          <EpicGraph
            :tasks="epic.tasks"
            :selected="flyout.ref.value"
            :minimap="props.mode === 'page'"
            :direction="props.mode === 'page' ? 'right' : 'down'"
            @open="openTask($event)"
          />
        </div>
      </section>
    </div>
  </div>
</template>
