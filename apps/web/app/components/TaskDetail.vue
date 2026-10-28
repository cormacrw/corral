<script setup lang="ts">
import type { AuditEntry, Comment, Evidence, Review, Task } from '@corral/contracts'
import type { TaskPriority, TaskStatus } from '@corral/core'
import { availableEvents } from '@corral/core'
import { api, ApiError } from '~/composables/useApi'
import { PRIORITY, STATUS, TASK_TYPE, timeAgo } from '~/utils/labels'

// One TaskDetail with two modes (design/task.md): docked flyout, or the
// task page with a properties rail
const props = defineProps<{ taskRef: string, mode: 'flyout' | 'page' }>()
const emit = defineEmits<{ close: [] }>()

const live = useLive()
const toast = useToast()
const task = ref<Task | null>(null)
const comments = ref<Comment[]>([])
const history = ref<AuditEntry[]>([])
const evidence = ref<Evidence[]>([])
const reviews = ref<Review[]>([])
const error = ref<string | null>(null)
const loading = ref(true)
const saved = ref(false)
const draft = ref('')
const editingDescription = ref(false)
// The editor's JSON document; its inner shape is the editor's business
const descriptionDraft = ref<{ type: 'doc', content?: never[] }>({ type: 'doc', content: [] })
const newCriterion = ref('')
const tab = ref<'activity' | 'evidence' | 'history'>('activity')
const confirmDelete = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

const project = computed(() => live.state.value.projects.find(p => p.id === task.value?.projectId) ?? null)
const number = computed(() => task.value?.number ?? 0)
const slug = computed(() => project.value?.slug ?? '')

async function load() {
  loading.value = true
  error.value = null
  try {
    task.value = await api.tasks.byRef(props.taskRef)
    await loadSide()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
async function loadSide() {
  if (!task.value || !project.value) return
  const [c, h, ev, r] = await Promise.all([
    api.tasks.comments(slug.value, number.value),
    api.tasks.history(slug.value, number.value),
    api.tasks.evidence(slug.value, number.value),
    api.tasks.reviews(slug.value, number.value)
  ])
  comments.value = c
  history.value = h
  evidence.value = ev
  reviews.value = r
}
watch(() => props.taskRef, () => {
  draft.value = ''
  editingDescription.value = false
  void load()
}, { immediate: true })
// Live updates for this task
onMounted(() => {
  const stop = live.subscribe((event) => {
    if (event.type === 'task.updated' && task.value && event.task.id === task.value.id) {
      task.value = event.task
      void loadSide()
    }
    if (event.type === 'comment.created' && task.value && event.comment.taskId === task.value.id) {
      if (!comments.value.some(c => c.id === event.comment.id)) comments.value.push(event.comment)
    }
  })
  onBeforeUnmount(stop)
})

function flashSaved() {
  saved.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    saved.value = false
  }, 1800)
}
function fail(e: unknown) {
  toast.add({ title: 'Not saved', description: e instanceof ApiError ? e.message : String(e), color: 'error' })
}

async function patch(input: Parameters<typeof api.tasks.patch>[2]) {
  if (!task.value) return
  try {
    task.value = await api.tasks.patch(slug.value, number.value, input)
    flashSaved()
  } catch (e) {
    fail(e)
  }
}

// Status: only the moves a human may make under D10
const statusOptions = computed(() => {
  if (!task.value) return []
  const state = { status: task.value.status, humanReview: task.value.humanReview, reviewRounds: task.value.reviewRounds, failedRuns: task.value.failedRuns, reason: task.value.statusReason }
  const events = availableEvents(state, { kind: 'human', userId: 'me' })
  const options: { label: string, value: string, status: TaskStatus }[] = [{ label: STATUS[task.value.status].label, value: 'current', status: task.value.status }]
  if (events.includes('approve')) options.push({ label: 'Ready', value: 'approve', status: 'ready' })
  if (events.includes('send_back')) options.push({ label: 'Backlog', value: 'send_back', status: 'backlog' })
  if (events.includes('human_request_changes')) options.push({ label: 'In progress (request changes)', value: 'human_request_changes', status: 'in_progress' })
  if (events.includes('resolve')) {
    options.push({ label: 'Backlog', value: 'resolve:backlog', status: 'backlog' }, { label: 'Ready', value: 'resolve:ready', status: 'ready' }, { label: 'In progress', value: 'resolve:in_progress', status: 'in_progress' })
  }
  return options
})
const statusEditable = computed(() => statusOptions.value.length > 1)
async function changeStatus(value: string) {
  if (!task.value || value === 'current') return
  try {
    if (value === 'approve') task.value = await api.tasks.transition(slug.value, number.value, { type: 'approve' })
    else if (value === 'send_back') task.value = await api.tasks.transition(slug.value, number.value, { type: 'send_back' })
    else if (value === 'human_request_changes') task.value = await api.tasks.transition(slug.value, number.value, { type: 'human_request_changes' })
    else if (value.startsWith('resolve:')) task.value = await api.tasks.transition(slug.value, number.value, { type: 'resolve', to: value.slice(8) as 'backlog' | 'ready' | 'in_progress' })
    flashSaved()
  } catch (e) {
    if (e instanceof ApiError && e.body?.code === 'transition_rejected' && e.body.reason.code === 'not_ready') {
      toast.add({ title: 'Not ready yet', description: `Needs: ${e.body.reason.problems.map(p => p.replaceAll('_', ' ')).join(', ')}`, color: 'warning' })
    } else fail(e)
  }
}

const priorityOptions = (Object.keys(PRIORITY) as TaskPriority[]).map(p => ({ label: PRIORITY[p].label, value: p }))
const typeOptions = (Object.keys(TASK_TYPE) as Task['type'][]).map(t => ({ label: TASK_TYPE[t], value: t }))
const developer = computed(() => live.state.value.agents.find(a => a.role === 'developer'))
const reviewer = computed(() => live.state.value.agents.find(a => a.role === 'reviewer'))

const metCount = computed(() => task.value?.acceptanceCriteria.filter(c => c.met).length ?? 0)
async function saveCriterion(id: string, text: string) {
  if (!task.value) return
  const list = task.value.acceptanceCriteria.map(c => ({ id: c.id, text: c.id === id ? text : c.text })).filter(c => c.text.trim())
  await patch({ acceptanceCriteria: list })
}
async function removeCriterion(id: string) {
  if (!task.value) return
  await patch({ acceptanceCriteria: task.value.acceptanceCriteria.filter(c => c.id !== id).map(c => ({ id: c.id, text: c.text })) })
}
async function addCriterion() {
  if (!task.value || !newCriterion.value.trim()) return
  await patch({ acceptanceCriteria: [...task.value.acceptanceCriteria.map(c => ({ id: c.id, text: c.text })), { text: newCriterion.value.trim() }] })
  newCriterion.value = ''
}

const dependencyChoices = computed(() => {
  if (!task.value || !project.value) return []
  return (live.state.value.tasks[project.value.id] ?? []).filter(t => t.id !== task.value!.id && !task.value!.dependsOn.includes(t.ref)).map(t => ({ label: `${t.ref} ${t.title}`, value: t.number }))
})
async function addDependency(n: number | null) {
  if (!task.value || n === null) return
  const numbers = task.value.dependsOn.map(ref => Number(ref.split('-')[1]))
  await patch({ dependsOn: [...numbers, n] })
}
async function removeDependency(ref: string) {
  if (!task.value) return
  await patch({ dependsOn: task.value.dependsOn.filter(r => r !== ref).map(r => Number(r.split('-')[1])) })
}
const dependencyTask = (ref: string) => (project.value ? live.state.value.tasks[project.value.id] ?? [] : []).find(t => t.ref === ref)

function startEditDescription() {
  descriptionDraft.value = (task.value?.description ?? { type: 'doc', content: [] }) as { type: 'doc' }
  editingDescription.value = true
}
async function saveDescription() {
  await patch({ description: descriptionDraft.value as { type: 'doc' } | null })
  editingDescription.value = false
}

const agentHolds = computed(() => task.value && ['in_progress', 'blocked', 'agent_review', 'human_review'].includes(task.value.status))
const composerHint = computed(() => agentHolds.value
  ? `${developer.value?.name ?? 'The developer'} gets this on its next step.`
  : 'No agent is working on this task, so this is saved as a note.')
async function sendComment(text: string) {
  if (!task.value) return
  try {
    const comment = await api.tasks.comment(slug.value, number.value, text)
    if (!comments.value.some(c => c.id === comment.id)) comments.value.push(comment)
    draft.value = ''
  } catch (e) {
    fail(e)
  }
}

async function remove() {
  if (!task.value) return
  try {
    await api.tasks.remove(slug.value, number.value)
    confirmDelete.value = false
    emit('close')
    toast.add({ title: `${task.value.ref} deleted`, color: 'neutral' })
  } catch (e) {
    fail(e)
  }
}

function authorLabel(actor: Comment['author']): string {
  if (actor.kind === 'human') return 'You'
  if (actor.kind === 'agent') return actor.role === 'pm' ? 'Juno' : actor.role === 'developer' ? (developer.value?.name ?? 'Developer') : (reviewer.value?.name ?? 'Reviewer')
  return 'Corral'
}
function historyText(entry: AuditEntry): string {
  const d = entry.detail
  switch (entry.action) {
    case 'task.created': return 'created the task'
    case 'task.updated': return `edited ${(d.changed as string[] | undefined)?.join(', ') ?? 'the task'}`
    case 'task.claimed': return `claimed it (${String(d.from).replaceAll('_', ' ')} → ${String(d.to).replaceAll('_', ' ')})`
    case 'task.transition': return `${String(d.from).replaceAll('_', ' ')} → ${String(d.to).replaceAll('_', ' ')}${d.error ? `: ${String(d.error)}` : ''}`
    case 'run.ended': return `run #${String(d.runNumber)} ended ${String(d.state)}${d.outcome ? ` (${String(d.outcome)})` : ''}${d.error ? `: ${String(d.error)}` : ''}`
    case 'review.recorded': return `review: ${String(d.verdict).replaceAll('_', ' ')} (${String(d.met)} of ${String(d.of)} criteria met) on ${String(d.headSha).slice(0, 10)}`
    case 'merge.refused': return `GitHub refused the merge: ${String(d.message)}`
    case 'branch.update_requested': return 'asked GitHub to update the branch from the base'
    case 'branch.head_moved': return `branch moved to ${String(d.to).slice(0, 10)}${d.approvalKept ? ' (approval kept)' : ''}`
    case 'worktrees.cleaned': return 'worktrees removed on the runner'
    case 'task.human_approved': return 'approved and merged'
    case 'task.deleted': return 'deleted the task'
    case 'run.stopped': return 'stopped the run'
    default: return entry.action
  }
}
const copyLink = () => navigator.clipboard?.writeText(`${location.origin}/tasks/${props.taskRef}`)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4">
      <template v-if="props.mode === 'flyout'">
        <span class="text-sm text-muted">{{ props.taskRef }}</span>
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
            :to="`/tasks/${props.taskRef}`"
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
      <template v-else>
        <UBreadcrumb :items="[{ label: 'Board', to: project ? `/projects/${project.slug}/board` : '/' }, { label: props.taskRef }]" />
        <span
          v-if="saved"
          class="ms-2 text-xs text-success"
        >✓ Saved</span>
      </template>
    </header>

    <div
      v-if="loading && !task"
      class="flex flex-col gap-3 p-4"
    >
      <USkeleton class="h-6 w-2/3" />
      <USkeleton class="h-4 w-full" />
      <USkeleton class="h-4 w-5/6" />
      <USkeleton class="h-24 w-full" />
    </div>
    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      :title="error"
      class="m-4"
      :actions="[{ label: 'Retry', onClick: load }]"
    />

    <div
      v-else-if="task"
      :class="['min-h-0 flex-1 overflow-y-auto', props.mode === 'page' ? 'mx-auto grid w-full max-w-[1200px] gap-8 p-6 max-[900px]:grid-cols-1 min-[900px]:grid-cols-[1fr_260px]' : 'p-4']"
    >
      <div class="flex min-w-0 flex-col gap-5">
        <input
          :value="task.title"
          class="w-full rounded-md bg-transparent px-1 py-0.5 text-lg font-semibold text-highlighted hover:bg-elevated focus:ring-2 focus:ring-primary focus:outline-none"
          aria-label="Title"
          @change="patch({ title: ($event.target as HTMLInputElement).value })"
        >

        <dl
          v-if="props.mode === 'flyout'"
          class="grid grid-cols-[104px_1fr] items-center gap-x-3 gap-y-2 text-sm"
        >
          <TaskProperties
            :task="task"
            :project="project"
            :status-options="statusOptions"
            :status-editable="statusEditable"
            :priority-options="priorityOptions"
            :type-options="typeOptions"
            :developer="developer"
            :reviewer="reviewer"
            @status="changeStatus"
            @patch="patch"
          />
        </dl>

        <section>
          <h3 class="mb-1 text-xs font-medium text-muted">
            Depends on
          </h3>
          <ul
            v-if="task.dependsOn.length > 0"
            class="flex flex-col gap-1"
          >
            <li
              v-for="ref in task.dependsOn"
              :key="ref"
              class="flex items-center gap-2 text-sm"
            >
              <NuxtLink
                :to="{ query: { ...$route.query, task: ref } }"
                class="font-mono text-muted"
              >{{ ref }}</NuxtLink>
              <span class="truncate">{{ dependencyTask(ref)?.title ?? '' }}</span>
              <StatusBadge
                v-if="dependencyTask(ref)"
                :status="dependencyTask(ref)!.status"
                size="xs"
              />
              <UButton
                icon="i-lucide-x"
                size="xs"
                variant="ghost"
                color="neutral"
                class="ms-auto"
                :aria-label="`Remove dependency ${ref}`"
                @click="removeDependency(ref)"
              />
            </li>
          </ul>
          <p
            v-else
            class="text-sm text-muted"
          >
            Nothing
          </p>
          <USelectMenu
            :items="dependencyChoices"
            value-key="value"
            placeholder="Add dependency"
            icon="i-lucide-plus"
            variant="ghost"
            size="sm"
            class="mt-1"
            :search-input="{ placeholder: 'Search tasks' }"
            @update:model-value="addDependency($event as number | null)"
          />
        </section>

        <section>
          <div class="mb-1 flex items-center justify-between">
            <h3 class="text-xs font-medium text-muted">
              Description
            </h3>
            <UButton
              v-if="!editingDescription"
              label="Edit"
              size="xs"
              variant="ghost"
              color="neutral"
              @click="startEditDescription"
            />
          </div>
          <template v-if="editingDescription">
            <UEditor
              v-model="descriptionDraft"
              content-type="json"
              class="rounded-md ring-2 ring-primary"
              placeholder="Describe the task…"
            >
              <template #default="{ editor }">
                <UEditorToolbar
                  :editor="editor"
                  :items="[[{ kind: 'mark', type: 'bold' }, { kind: 'mark', type: 'italic' }, { kind: 'mark', type: 'code' }], [{ kind: 'heading', level: 2 }, { kind: 'bulletList' }, { kind: 'orderedList' }, { kind: 'codeBlock' }, { kind: 'link' }]]"
                  class="border-b border-default"
                />
              </template>
            </UEditor>
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
          <UEditor
            v-else
            :model-value="(task.description ?? { type: 'doc', content: [] }) as never"
            content-type="json"
            :editable="false"
            placeholder="No description"
            class="text-sm"
          />
          <p
            v-if="agentHolds && task.lease"
            class="mt-1 text-xs text-muted"
          >
            Changes and comments are sent to {{ developer?.name ?? 'the developer' }}.
          </p>
        </section>

        <section>
          <div class="mb-1 flex items-center justify-between">
            <h3 class="text-xs font-medium text-muted">
              Acceptance criteria · {{ metCount }} of {{ task.acceptanceCriteria.length }} met
            </h3>
          </div>
          <ul class="flex flex-col gap-1">
            <li
              v-for="criterion in task.acceptanceCriteria"
              :key="criterion.id"
              class="flex items-start gap-2 text-sm"
            >
              <UIcon
                :name="criterion.met ? 'i-lucide-circle-check' : criterion.met === false ? 'i-lucide-circle-x' : 'i-lucide-circle'"
                :class="['mt-1 size-4 shrink-0', criterion.met ? 'text-success' : criterion.met === false ? 'text-error' : 'text-dimmed']"
                :aria-label="criterion.met ? 'Met' : criterion.met === false ? 'Not met' : 'Open'"
              />
              <input
                :value="criterion.text"
                class="min-w-0 flex-1 rounded bg-transparent px-1 hover:bg-elevated focus:ring-2 focus:ring-primary focus:outline-none"
                :aria-label="`Criterion: ${criterion.text}`"
                @change="saveCriterion(criterion.id, ($event.target as HTMLInputElement).value)"
              >
              <UButton
                icon="i-lucide-x"
                size="xs"
                variant="ghost"
                color="neutral"
                aria-label="Remove criterion"
                @click="removeCriterion(criterion.id)"
              />
            </li>
          </ul>
          <form
            class="mt-2 flex gap-2"
            @submit.prevent="addCriterion"
          >
            <UInput
              v-model="newCriterion"
              placeholder="Add criterion"
              size="sm"
              class="flex-1"
            />
            <UButton
              type="submit"
              label="Add"
              size="sm"
              variant="outline"
              color="neutral"
              :disabled="!newCriterion.trim()"
            />
          </form>
          <p class="mt-1 text-xs text-muted">
            The reviewer marks criteria met from evidence.
          </p>
        </section>

        <section class="flex min-h-0 flex-col">
          <UTabs
            v-model="tab"
            :items="[{ label: 'Activity', value: 'activity' }, { label: `Evidence (${evidence.length})`, value: 'evidence' }, { label: 'History', value: 'history' }]"
            variant="link"
            size="sm"
            :content="false"
          />
          <div
            v-if="tab === 'activity'"
            class="mt-3 flex flex-col gap-3"
          >
            <div
              v-for="comment in comments"
              :key="comment.id"
              class="flex gap-2"
            >
              <UAvatar
                :text="authorLabel(comment.author).slice(0, 2).toUpperCase()"
                size="xs"
              />
              <div class="min-w-0 flex-1 rounded-lg bg-elevated px-3 py-2 text-sm">
                <div class="mb-0.5 flex items-center gap-2 text-xs text-muted">
                  <span class="font-medium text-default">{{ authorLabel(comment.author) }}</span>
                  <span>{{ timeAgo(comment.createdAt) }}</span>
                  <UBadge
                    v-if="comment.pinned"
                    label="Pinned"
                    size="xs"
                    variant="subtle"
                  />
                </div>
                <p class="whitespace-pre-wrap">
                  {{ comment.body }}
                </p>
              </div>
            </div>
            <p
              v-if="comments.length === 0"
              class="text-sm text-muted"
            >
              No comments yet.
            </p>
            <PromptComposer
              v-model="draft"
              placeholder="Comment…"
              :hint="composerHint"
              @submit="sendComment"
            />
          </div>
          <div
            v-else-if="tab === 'evidence'"
            class="mt-3"
          >
            <EvidenceList
              :evidence="evidence"
              :criteria="task.acceptanceCriteria"
              :reviews="reviews"
            />
          </div>
          <ol
            v-else
            class="mt-3 flex flex-col gap-2 text-sm"
          >
            <li
              v-for="entry in history"
              :key="entry.id"
              class="flex gap-2"
            >
              <span
                class="mt-2 size-1.5 shrink-0 rounded-full bg-accented"
                aria-hidden="true"
              />
              <div class="min-w-0">
                <span class="font-medium">{{ authorLabel(entry.actor) }}</span>
                <span class="text-muted"> {{ historyText(entry) }}</span>
                <span class="ms-2 text-xs text-dimmed">{{ timeAgo(entry.createdAt) }}</span>
              </div>
            </li>
          </ol>
        </section>

        <section
          v-if="task.status !== 'merged'"
          class="border-t border-default pt-3"
        >
          <UButton
            label="Delete task"
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            size="sm"
            @click="confirmDelete = true"
          />
          <UModal
            v-model:open="confirmDelete"
            :title="`Delete ${task.ref}?`"
            :description="task.status === 'backlog' ? 'Backlog tasks are deleted outright.' : 'Stops any run, closes the PR and deletes the branch when safe. The task and its history are kept but hidden. Dependents become Blocked.'"
          >
            <template #footer>
              <UButton
                label="Cancel"
                variant="outline"
                color="neutral"
                @click="confirmDelete = false"
              />
              <UButton
                label="Delete"
                color="error"
                @click="remove"
              />
            </template>
          </UModal>
        </section>
      </div>

      <dl
        v-if="props.mode === 'page'"
        class="flex flex-col gap-3 text-sm"
      >
        <TaskProperties
          :task="task"
          :project="project"
          :status-options="statusOptions"
          :status-editable="statusEditable"
          :priority-options="priorityOptions"
          :type-options="typeOptions"
          :developer="developer"
          :reviewer="reviewer"
          stacked
          @status="changeStatus"
          @patch="patch"
        />
      </dl>
    </div>
  </div>
</template>
