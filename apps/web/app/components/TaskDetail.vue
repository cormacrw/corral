<script setup lang="ts">
import type { AuditEntry, Comment, Evidence, Review, Run, Task } from '@corral/contracts'
import type { EditorToolbarItem } from '@nuxt/ui'
import type { EditorView } from '@tiptap/pm/view'
import type { TaskPriority, TaskStatus } from '@corral/core'
import { availableEvents } from '@corral/core'
import { api, ApiError } from '~/composables/useApi'
import { PRIORITY, runBadge, STATUS, TASK_TYPE, timeAgo } from '~/utils/labels'
import { attachmentProblem } from '~/utils/attachments'
import { AttachmentImage, imageFiles, insertImages } from '~/utils/editor-image'

// One TaskDetail with three modes (design/task.md): docked flyout, the
// task page with a properties rail, or the full mobile page with Details
// and Criteria and activity tabs (design/mobile.md)
const props = defineProps<{ taskRef: string, mode: 'flyout' | 'page' | 'mobile' }>()
const emit = defineEmits<{ close: [] }>()

const live = useLive()
const flyout = useTaskFlyout()
const toast = useToast()
const task = ref<Task | null>(null)
const comments = ref<Comment[]>([])
const history = ref<AuditEntry[]>([])
const evidence = ref<Evidence[]>([])
const reviews = ref<Review[]>([])
// The task's runs, so activity names the agent that acted
const runs = ref<Run[]>([])
const error = ref<string | null>(null)
const loading = ref(true)
const saved = ref(false)
const draft = ref('')
const editingDescription = ref(false)
// The editor's JSON document; its inner shape is the editor's business
const descriptionDraft = ref<{ type: 'doc', content?: never[] }>({ type: 'doc', content: [] })
const newCriterion = ref('')
// PR bodies link to ?evidence=1
const tab = ref<'activity' | 'evidence' | 'history'>(useRoute().query.evidence ? 'evidence' : 'activity')
// Mobile splits the body in two; evidence lives with criteria and activity
const mobileTab = ref<'details' | 'criteria'>(useRoute().query.evidence ? 'criteria' : 'details')
const mobile = computed(() => props.mode === 'mobile')
// Every part shows in the flyout and page; mobile shows one tab's parts
const shows = (part: 'details' | 'criteria') => !mobile.value || mobileTab.value === part
const confirmDelete = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

const project = computed(() => live.state.value.projects.find(p => p.id === task.value?.projectId) ?? null)
const number = computed(() => task.value?.number ?? 0)
const epic = computed(() => task.value?.epicId ? live.state.value.epics[task.value.projectId]?.find(e => e.id === task.value!.epicId) ?? null : null)
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
  const [c, h, ev, r, ru] = await Promise.all([
    api.tasks.comments(slug.value, number.value),
    api.tasks.history(slug.value, number.value),
    api.tasks.evidence(slug.value, number.value),
    api.tasks.reviews(slug.value, number.value),
    api.runs.list({ taskId: task.value.id })
  ])
  comments.value = c
  history.value = h
  evidence.value = ev
  reviews.value = r
  runs.value = ru
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
    if (event.type === 'run.updated' && task.value && event.run.taskId === task.value.id) void loadSide()
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
  const state = { type: task.value.type, status: task.value.status, humanReview: task.value.humanReview, reviewRounds: task.value.reviewRounds, failedRuns: task.value.failedRuns, reason: task.value.statusReason }
  const events = availableEvents(state, { kind: 'human', userId: 'me' })
  const options: { label: string, value: string, status: TaskStatus }[] = [{ label: STATUS[task.value.status].label, value: 'current', status: task.value.status }]
  if (events.includes('approve')) options.push({ label: 'Ready', value: 'approve', status: 'ready' })
  if (events.includes('send_back')) options.push({ label: 'Backlog', value: 'send_back', status: 'backlog' })
  if (events.includes('human_request_changes') && task.value.status !== 'approved') options.push({ label: 'In progress (request changes)', value: 'human_request_changes', status: 'in_progress' })
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

const resuming = ref(false)
async function resume() {
  if (!task.value) return
  resuming.value = true
  try {
    task.value = await api.tasks.resume(slug.value, number.value)
    flashSaved()
  } catch (e) {
    fail(e)
  } finally {
    resuming.value = false
  }
}

const priorityOptions = (Object.keys(PRIORITY) as TaskPriority[]).map(p => ({ label: PRIORITY[p].label, value: p }))
const typeOptions = (Object.keys(TASK_TYPE) as Task['type'][]).map(t => ({ label: TASK_TYPE[t], value: t }))
// Tasks aren't assigned ahead of time: these are the agents of the task's
// latest runs, or null until one claims it (D15)
const developer = computed(() => task.value?.developer ?? null)
const reviewer = computed(() => task.value?.reviewer ?? null)

async function toggleHumanCriterion(id: string, checked: boolean) {
  if (!task.value) return
  await patch({ acceptanceCriteria: task.value.acceptanceCriteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.id === id ? checked : c.checkedByHuman })) })
}
const metCount = computed(() => task.value?.acceptanceCriteria.filter(c => c.met).length ?? 0)
async function saveCriterion(id: string, text: string) {
  if (!task.value) return
  const list = task.value.acceptanceCriteria.map(c => ({ id: c.id, text: c.id === id ? text : c.text, checkedByHuman: c.checkedByHuman })).filter(c => c.text.trim())
  await patch({ acceptanceCriteria: list })
}
async function removeCriterion(id: string) {
  if (!task.value) return
  await patch({ acceptanceCriteria: task.value.acceptanceCriteria.filter(c => c.id !== id).map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })) })
}
async function addCriterion() {
  if (!task.value || !newCriterion.value.trim()) return
  await patch({ acceptanceCriteria: [...task.value.acceptanceCriteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })), { text: newCriterion.value.trim() }] })
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
  descriptionDraft.value = structuredClone(toRaw(task.value?.description ?? { type: 'doc', content: [] })) as { type: 'doc' }
  editingDescription.value = true
}
// Following a link or selecting text to copy shouldn't open an editor
function wantsEdit(event: MouseEvent) {
  return !(event.target as HTMLElement).closest('a, button') && !window.getSelection()?.toString()
}
function onDescriptionClick(event: MouseEvent) {
  if (wantsEdit(event)) startEditDescription()
}
// The editor's defaults suit a full page; a task's description sits in a
// narrow column at body text size
const descriptionUi = {
  base: 'text-sm sm:px-0 *:my-2 [&_p]:leading-6 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h2>code]:text-sm [&_h3>code]:text-sm [&_li]:my-0.5 [&_pre]:px-3 [&_pre]:py-2 [&_pre]:text-xs/5 [&_code]:text-xs [&_img]:max-w-full [&_img]:rounded-md [&_img.ProseMirror-selectednode]:ring-2 [&_img.ProseMirror-selectednode]:ring-primary'
}
// Images upload as attachments and are stored as attachment:<id>
// (utils/editor-image.ts); pasted, dropped or picked from the toolbar
const descriptionExtensions = [AttachmentImage]
const descriptionEditor = useTemplateRef<{ editor?: { view: EditorView } }>('descriptionEditor')
const imageInput = useTemplateRef<HTMLInputElement>('imageInput')
const uploadingImages = ref(0)
async function uploadImage(file: File): Promise<{ id: string } | null> {
  const name = file.name || 'pasted-image.png'
  const problem = attachmentProblem(file)
  if (problem) {
    toast.add({ title: `Couldn't add ${name}`, description: problem, color: 'error' })
    return null
  }
  uploadingImages.value++
  try {
    return await api.attachments.upload(slug.value, file, name)
  } catch (e) {
    toast.add({ title: `Couldn't upload ${name}`, description: e instanceof Error ? e.message : String(e), color: 'error' })
    return null
  } finally {
    uploadingImages.value--
  }
}
const descriptionEditorProps = {
  handlePaste: (view: EditorView, event: ClipboardEvent) => {
    const files = imageFiles(event.clipboardData)
    if (files.length === 0) return false
    insertImages(view, files, uploadImage)
    return true
  },
  handleDrop: (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean) => {
    const files = moved ? [] : imageFiles(event.dataTransfer)
    if (files.length === 0) return false
    event.preventDefault()
    insertImages(view, files, uploadImage, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
    return true
  }
}
function onImagePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const view = descriptionEditor.value?.editor?.view
  if (view) insertImages(view, imageFiles({ files: input.files } as DataTransfer), uploadImage)
  input.value = ''
}
const toolbarItems: EditorToolbarItem[][] = [
  [
    { 'kind': 'mark', 'mark': 'bold', 'icon': 'i-lucide-bold', 'aria-label': 'Bold' },
    { 'kind': 'mark', 'mark': 'italic', 'icon': 'i-lucide-italic', 'aria-label': 'Italic' },
    { 'kind': 'mark', 'mark': 'code', 'icon': 'i-lucide-code', 'aria-label': 'Inline code' }
  ],
  [
    { 'kind': 'heading', 'level': 2, 'icon': 'i-lucide-heading-2', 'aria-label': 'Heading' },
    { 'kind': 'bulletList', 'icon': 'i-lucide-list', 'aria-label': 'Bulleted list' },
    { 'kind': 'orderedList', 'icon': 'i-lucide-list-ordered', 'aria-label': 'Numbered list' },
    { 'kind': 'codeBlock', 'icon': 'i-lucide-square-code', 'aria-label': 'Code block' },
    { 'kind': 'link', 'icon': 'i-lucide-link', 'aria-label': 'Link' },
    { 'icon': 'i-lucide-image', 'aria-label': 'Insert image', 'onClick': () => imageInput.value?.click() }
  ]
] as const
async function saveDescription() {
  // Enter at the end leaves empty paragraphs behind
  const content = [...(descriptionDraft.value.content ?? [])] as { type: string, content?: unknown[] }[]
  while (content.length > 0 && content.at(-1)!.type === 'paragraph' && !content.at(-1)!.content?.length) content.pop()
  await patch({ description: { ...descriptionDraft.value, content } as { type: 'doc' } })
  editingDescription.value = false
}

// A Draft from a plan: the task itself, without the work around it. It's
// placed only with the whole plan, from the plan flyout
const isDraft = computed(() => task.value?.status === 'draft')
const editingCriterion = ref<string | null>(null)
// Merged is final (D10): the task reads as it shipped; only comments change
const readonly = computed(() => task.value?.status === 'merged')
const placing = ref(false)
async function place() {
  if (!task.value) return
  placing.value = true
  try {
    task.value = await api.tasks.transition(slug.value, number.value, { type: 'approve' })
    toast.add({ title: `${task.value.ref} added to the board`, color: 'success' })
  } catch (e) {
    if (e instanceof ApiError && e.body?.code === 'transition_rejected' && e.body.reason.code === 'not_ready') {
      toast.add({ title: 'Not ready yet', description: `Needs: ${e.body.reason.problems.map(p => p.replaceAll('_', ' ')).join(', ')}`, color: 'warning' })
    } else fail(e)
  } finally {
    placing.value = false
  }
}

const agentHolds = computed(() => task.value && ['in_progress', 'blocked', 'agent_review', 'human_review'].includes(task.value.status))
const composerHint = computed(() => agentHolds.value
  ? `${developer.value?.name ?? (task.value?.type === 'design' ? 'The designer' : 'The developer')} gets this on its next step.`
  : 'No agent is working on this task, so this is saved as a note.')
// Resolves false when not sent, so the composer keeps its images
async function sendComment(text: string): Promise<boolean> {
  if (!task.value) return false
  try {
    const comment = await api.tasks.comment(slug.value, number.value, text)
    if (!comments.value.some(c => c.id === comment.id)) comments.value.push(comment)
    draft.value = ''
    return true
  } catch (e) {
    fail(e)
    return false
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

// Comments and the runs that ended with an error, oldest first
const activity = computed(() => [
  ...comments.value.map(comment => ({ id: comment.id, at: comment.createdAt, comment, run: null })),
  ...runs.value.filter(run => run.error && run.endedAt).map(run => ({ id: run.id, at: run.endedAt!, comment: null, run }))
].sort((a, b) => a.at.localeCompare(b.at)))

function authorLabel(actor: Comment['author']): string {
  if (actor.kind === 'human') return 'You'
  if (actor.kind === 'agent') {
    const run = runs.value.find(r => r.id === actor.runId)
    if (run) return run.agentName
    return actor.role === 'pm' ? (live.state.value.agents.find(a => a.role === 'pm')?.name ?? 'PM') : actor.role === 'developer' ? 'Developer' : actor.role === 'designer' ? 'Designer' : 'Reviewer'
  }
  return 'Corral'
}
function historyText(entry: AuditEntry): string {
  const d = entry.detail
  switch (entry.action) {
    case 'task.created': return 'created the task'
    case 'task.updated': return `edited ${(d.changed as string[] | undefined)?.join(', ') ?? 'the task'}`
    case 'task.revised': return `revised it with plan v${String(d.version)}`
    case 'task.claimed': return `claimed it (${String(d.from).replaceAll('_', ' ')} → ${String(d.to).replaceAll('_', ' ')})`
    case 'task.transition': return `${String(d.from).replaceAll('_', ' ')} → ${String(d.to).replaceAll('_', ' ')}${d.error ? `: ${String(d.error)}` : ''}`
    case 'run.ended': return `run #${String(d.runNumber)} ended ${String(d.state)}${d.outcome ? ` (${String(d.outcome)})` : ''}${d.error ? `: ${String(d.error)}` : ''}`
    case 'review.recorded': return `review: ${String(d.verdict).replaceAll('_', ' ')} (${String(d.met)} of ${String(d.of)} criteria met) on ${String(d.headSha).startsWith('findings-') ? 'the findings' : String(d.headSha).slice(0, 10)}`
    case 'merge.refused': return `GitHub refused the merge: ${String(d.message)}`
    case 'branch.update_requested': return 'asked GitHub to update the branch from the base'
    case 'branch.head_moved': return `branch moved to ${String(d.to).slice(0, 10)}${d.approvalKept ? ' (approval kept)' : ''}`
    case 'worktrees.cleaned': return 'worktrees removed on the runner'
    case 'task.human_approved': return 'approved the merge'
    case 'design.approved': return `approved design v${String(d.version)}`
    case 'task.deleted': return 'deleted the task'
    case 'run.stopped': return 'stopped the run'
    case 'task.resumed': return 'resumed the task'
    default: return entry.action
  }
}
const workingAgent = computed(() => task.value?.lease ? live.state.value.agents.find(a => a.id === task.value!.lease!.agentId) ?? null : null)
const copyLink = () => navigator.clipboard?.writeText(`${location.origin}/tasks/${props.taskRef}`)
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
        <nav
          aria-label="Breadcrumb"
          class="flex min-w-0 items-center gap-1 text-sm text-muted"
        >
          <template v-if="epic">
            <button
              type="button"
              class="max-w-48 truncate hover:text-highlighted hover:underline"
              :title="epic.title"
              @click="flyout.openEpic(epic.id)"
            >
              {{ epic.title }}
            </button>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 shrink-0"
              aria-hidden="true"
            />
          </template>
          <span
            class="shrink-0"
            aria-current="page"
          >{{ props.taskRef }}</span>
        </nav>
        <UBadge
          v-if="isDraft"
          label="Draft"
          color="neutral"
          variant="subtle"
          size="sm"
        />
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
      <template v-else-if="mobile">
        <UButton
          icon="i-lucide-arrow-left"
          variant="ghost"
          color="neutral"
          aria-label="Back"
          class="-ms-2"
          @click="emit('close')"
        />
        <div class="min-w-0 flex-1 leading-tight">
          <NuxtLink
            v-if="epic"
            :to="`/epics/${epic.id}`"
            class="block truncate text-xs text-muted underline"
          >{{ epic.title }} ›</NuxtLink>
          <h1 class="flex items-center gap-2 text-base font-semibold text-highlighted">
            {{ props.taskRef }}
            <UBadge
              v-if="isDraft"
              label="Draft"
              color="neutral"
              variant="subtle"
              size="sm"
            />
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
        <UDropdownMenu
          v-if="task && task.status !== 'merged'"
          :items="[{ label: 'Delete task', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => { confirmDelete = true } }]"
          :content="{ align: 'end' }"
        >
          <UButton
            icon="i-lucide-ellipsis"
            variant="ghost"
            color="neutral"
            aria-label="More"
          />
        </UDropdownMenu>
      </template>
      <template v-else>
        <UBreadcrumb :items="[{ label: 'Board', to: project ? `/projects/${project.slug}/board` : '/' }, ...(epic ? [{ label: epic.title, to: `/epics/${epic.id}` }] : []), { label: props.taskRef }]" />
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
      :class="['min-h-0 flex-1 overflow-y-auto overscroll-contain', props.mode === 'page' ? 'mx-auto grid w-full max-w-[1200px] gap-8 p-6 max-[900px]:grid-cols-1 min-[900px]:grid-cols-[1fr_260px]' : mobile ? 'pt-4 pb-[env(safe-area-inset-bottom)]' : 'p-4']"
    >
      <div :class="['flex min-w-0 flex-col gap-5', mobile && '*:mx-4']">
        <h2
          v-if="readonly"
          class="px-1 py-0.5 text-lg font-semibold text-highlighted"
        >
          {{ task.title }}
        </h2>
        <input
          v-else
          :value="task.title"
          class="self-stretch rounded-md bg-transparent px-1 py-0.5 text-lg font-semibold text-highlighted hover:bg-elevated focus:ring-2 focus:ring-primary focus:outline-none"
          aria-label="Title"
          @change="patch({ title: ($event.target as HTMLInputElement).value })"
        >

        <!-- Above the mobile tabs, so it shows on both -->
        <div
          v-if="task.paused"
          :class="['flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm', mobile && '-mt-2']"
          data-testid="task-paused"
        >
          <UIcon
            name="i-lucide-pause"
            class="size-4 shrink-0 text-warning"
          />
          <span class="min-w-0 flex-1"><span class="font-medium">Paused.</span> <span class="text-muted">Its run was stopped, so nothing picks it up until you resume it.</span></span>
          <UButton
            label="Resume"
            icon="i-lucide-play"
            size="sm"
            :class="mobile && 'min-h-11'"
            :loading="resuming"
            @click="resume"
          />
        </div>

        <template v-if="mobile">
          <div
            v-if="agentHolds && task.lease && workingAgent"
            class="-mt-2 flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm"
          >
            <AgentAvatar
              :name="workingAgent.name"
              size="xs"
              working
            />
            <span class="min-w-0 flex-1 truncate"><span class="font-medium">{{ workingAgent.name }}</span> <span class="text-muted">is working</span></span>
            <NuxtLink
              :to="`/agents/${workingAgent.name.toLowerCase()}/${task.lease.runId}`"
              class="font-medium text-primary"
            >Watch</NuxtLink>
          </div>
          <UTabs
            v-model="mobileTab"
            :items="[{ label: 'Details', value: 'details' }, { label: isDraft ? 'Criteria' : 'Criteria and activity', value: 'criteria' }]"
            :content="false"
            :ui="{ indicator: 'bg-default shadow-xs', trigger: 'data-[state=active]:text-highlighted' }"
            class="-mt-2"
          />
        </template>

        <p
          v-if="readonly && shows('details')"
          class="flex items-center gap-1.5 text-xs text-muted"
        >
          <UIcon
            name="i-lucide-lock"
            class="size-3.5"
          />
          Merged, so read-only. You can still comment.
        </p>

        <div
          v-if="isDraft && shows('details')"
          class="flex flex-wrap items-center gap-2 rounded-lg border border-default bg-muted px-3 py-2 text-sm"
        >
          <span class="me-auto text-muted">Proposed in a plan. Only you can see it until you add the plan to the board or the Backlog.</span>
          <UButton
            v-if="task.planSessionId"
            label="Open plan session"
            trailing-icon="i-lucide-arrow-right"
            variant="link"
            size="sm"
            :to="`/plan/${task.planSessionId}`"
            data-testid="task-plan-session"
          />
        </div>
        <div
          v-else-if="task.status === 'backlog' && shows('details')"
          class="flex flex-wrap items-center gap-2 rounded-lg border border-default bg-muted px-3 py-2 text-sm"
        >
          <span class="me-auto text-muted">In the Backlog, so never scheduled until you move it.</span>
          <UButton
            label="Move to board"
            icon="i-lucide-kanban"
            size="sm"
            :loading="placing"
            @click="place()"
          />
        </div>

        <dl
          v-if="props.mode === 'flyout' || (mobile && shows('details'))"
          :class="['grid grid-cols-[112px_1fr] text-sm', mobile ? 'mx-0! -mt-2 border-y border-default px-4 [&>*]:min-h-11 [&>*:not(:nth-last-child(-n+2))]:border-b [&>*]:border-default' : 'gap-x-4 gap-y-1']"
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
            :draft="isDraft"
            :readonly="readonly"
            @status="changeStatus"
            @patch="patch"
          />
        </dl>

        <DesignReview
          v-if="task.type === 'design' && !isDraft && shows('details')"
          :task="task"
          :slug="slug"
          :mobile="mobile"
          @updated="task = $event"
        />

        <section v-if="shows('details')">
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
                :to="mobile ? `/tasks/${ref}` : { query: { ...$route.query, task: ref } }"
                class="font-mono text-muted"
              >{{ ref }}</NuxtLink>
              <span class="truncate">{{ dependencyTask(ref)?.title ?? '' }}</span>
              <StatusBadge
                v-if="dependencyTask(ref)"
                :status="dependencyTask(ref)!.status"
                size="xs"
              />
              <UButton
                v-if="!readonly"
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
            v-if="!readonly"
            :items="dependencyChoices"
            value-key="value"
            placeholder="Add dependency"
            icon="i-lucide-plus"
            variant="ghost"
            size="sm"
            class="mt-1 -ms-2.5"
            :search-input="{ placeholder: 'Search tasks' }"
            @update:model-value="addDependency($event as number | null)"
          />
        </section>

        <section v-if="shows('details')">
          <h3 class="mb-1 text-xs font-medium text-muted">
            Description
          </h3>
          <template v-if="editingDescription">
            <UEditor
              ref="descriptionEditor"
              v-slot="{ editor }"
              v-model="descriptionDraft"
              content-type="json"
              :image="false"
              :extensions="descriptionExtensions"
              :editor-props="descriptionEditorProps"
              autofocus="end"
              class="rounded-md ring-2 ring-primary"
              :ui="{ ...descriptionUi, base: `${descriptionUi.base} min-h-24 px-3 py-2 sm:px-3` }"
              placeholder="Describe the task…"
              @keydown.esc="editingDescription = false"
            >
              <UEditorToolbar
                :editor="editor"
                :items="toolbarItems"
                class="border-b border-default px-1 py-1"
              />
            </UEditor>
            <input
              ref="imageInput"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              class="hidden"
              @change="onImagePicked"
            >
            <div class="mt-2 flex justify-end gap-2">
              <UButton
                label="Cancel"
                variant="outline"
                color="neutral"
                size="sm"
                @click="editingDescription = false"
              />
              <UButton
                :label="uploadingImages > 0 ? 'Uploading…' : 'Save'"
                size="sm"
                :disabled="uploadingImages > 0"
                @click="saveDescription"
              />
            </div>
          </template>
          <!-- Click anywhere on the description to edit it; links still open -->
          <div
            v-else
            :role="readonly ? undefined : 'button'"
            :tabindex="readonly ? undefined : 0"
            :aria-label="readonly ? undefined : 'Edit description'"
            :class="['-mx-2 rounded-md px-2 py-1', !readonly && 'cursor-text hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none']"
            @click="!readonly && onDescriptionClick($event)"
            @keydown.enter.self.prevent="!readonly && startEditDescription()"
          >
            <RichTextText
              :doc="task.description"
              class="text-sm"
            />
          </div>
          <p
            v-if="agentHolds && task.lease"
            class="mt-1 text-xs text-muted"
          >
            Changes and comments are sent to {{ developer?.name ?? (task?.type === 'design' ? 'the designer' : 'the developer') }}.
          </p>
        </section>

        <section v-if="shows('criteria')">
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
              <div class="min-w-0 flex-1">
                <div
                  v-if="readonly || editingCriterion !== criterion.id"
                  :role="readonly ? undefined : 'button'"
                  :tabindex="readonly ? undefined : 0"
                  :aria-label="readonly ? undefined : `Edit criterion: ${criterion.text}`"
                  class="rounded px-1 py-0.5 hover:bg-elevated"
                  @click="!readonly && wantsEdit($event) && (editingCriterion = criterion.id)"
                  @keydown.enter.self.prevent="!readonly && (editingCriterion = criterion.id)"
                >
                  <MarkdownText :text="criterion.text" />
                </div>
                <UTextarea
                  v-else
                  :model-value="criterion.text"
                  autofocus
                  autoresize
                  :rows="1"
                  variant="none"
                  size="sm"
                  class="w-full"
                  :ui="{ base: 'px-1 py-0 text-sm/6 hover:bg-elevated focus:ring-2 focus:ring-primary' }"
                  :aria-label="`Criterion: ${criterion.text}`"
                  @change="saveCriterion(criterion.id, ($event.target as HTMLTextAreaElement).value)"
                  @blur="editingCriterion = null"
                />
                <label class="mt-1 flex items-center gap-1 px-1 text-xs text-muted">
                  <input
                    type="checkbox"
                    :checked="criterion.checkedByHuman"
                    :disabled="readonly"
                    @change="toggleHumanCriterion(criterion.id, ($event.target as HTMLInputElement).checked)"
                  >
                  Checked by a human
                </label>
              </div>
              <UButton
                v-if="!readonly"
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
            v-if="!readonly"
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
            {{ task.acceptanceCriteria.some(c => c.checkedByHuman)
              ? 'The reviewer checks other criteria from evidence. Human checks are completed in the Inbox.'
              : 'The reviewer marks criteria met from evidence.' }}
          </p>
        </section>

        <section
          v-if="!isDraft && shows('criteria')"
          class="flex min-h-0 flex-col"
        >
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
            <template
              v-for="item in activity"
              :key="item.id"
            >
              <div
                v-if="item.comment"
                class="flex gap-2"
              >
                <AgentAvatar
                  :name="authorLabel(item.comment.author)"
                  size="xs"
                />
                <div class="min-w-0 flex-1 rounded-lg bg-elevated px-3 py-2 text-sm">
                  <div class="mb-0.5 flex items-center gap-2 text-xs text-muted">
                    <span class="font-medium text-default">{{ authorLabel(item.comment.author) }}</span>
                    <span>{{ timeAgo(item.comment.createdAt) }}</span>
                    <UBadge
                      v-if="item.comment.pinned"
                      label="Pinned"
                      size="xs"
                      variant="subtle"
                    />
                  </div>
                  <MarkdownText :text="item.comment.body" />
                </div>
              </div>
              <div
                v-else-if="item.run"
                class="flex gap-2 text-sm"
                data-testid="activity-run-error"
              >
                <span
                  class="mx-1.5 mt-1.5 size-2 shrink-0 rounded-full bg-error"
                  aria-hidden="true"
                />
                <p class="min-w-0 flex-1 text-muted">
                  <span class="font-medium text-default">{{ item.run.agentName }}</span>
                  run #{{ item.run.number }} ended {{ runBadge(item.run).label.toLowerCase() }}: {{ item.run.error }}
                  <span class="text-xs">· {{ timeAgo(item.run.endedAt!) }}</span>
                </p>
              </div>
            </template>
            <p
              v-if="activity.length === 0"
              class="text-sm text-muted"
            >
              No comments yet.
            </p>
            <PromptComposer
              v-model="draft"
              placeholder="Comment…"
              :hint="composerHint"
              :project="slug || null"
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
          :class="mobile ? 'hidden' : 'border-t border-default pt-3'"
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
            :description="task.status === 'backlog' || task.status === 'draft' ? `${STATUS[task.status].label} tasks are deleted outright.` : 'Stops any run, closes the PR and deletes the branch when safe. The task and its history are kept but hidden. Dependents become Blocked.'"
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
          :draft="isDraft"
          :readonly="readonly"
          stacked
          @status="changeStatus"
          @patch="patch"
        />
      </dl>
    </div>
  </div>
</template>
