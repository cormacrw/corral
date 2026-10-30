<script setup lang="ts">
import type { Evidence, Inbox, InboxActionInput, Review, Task, InboxItem, PlanThreadItem } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { inboxTypeBadge as typeBadge, timeAgo } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'

// The Inbox (design/inbox.md, D11): list, selected item, action tray, task flyout
const route = useRoute()
const router = useRouter()
const live = useLive()
const flyout = useTaskFlyout()
const toast = useToast()
const device = useDevice()
const deletes = usePlanThreadDelete()
useSeoMeta({ title: 'Inbox · Corral' })

const inbox = ref<Inbox | null>(null)
const error = ref<string | null>(null)
const tab = ref<'needsYou' | 'activity' | 'resolved'>('needsYou')
const search = ref('')
const action = ref<InboxActionInput['action'] | null>(null)
const resolveTo = ref<'backlog' | 'ready' | 'in_progress'>('in_progress')
const text = ref('')
const busy = ref(false)
const actionError = ref<string | null>(null)
const task = ref<Task | null>(null)
const evidence = ref<Evidence[]>([])
const reviews = ref<Review[]>([])
const showTask = ref(true)
const planResolving = ref(false)
let resolutionPosition = 0

async function load() {
  if (planResolving.value) return
  error.value = null
  try {
    const loaded = await api.inbox.get()
    if (!planResolving.value) inbox.value = loaded
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
onMounted(() => {
  void load()
  const stop = live.subscribe((event) => {
    if (['task.updated', 'task.deleted', 'task.created', 'run.updated', 'plan.session'].includes(event.type)) void load()
  })
  onBeforeUnmount(stop)
})

// In the server's order (newest first, D11), less threads waiting out their Undo
const items = computed<InboxItem[]>(() => (inbox.value?.[tab.value] ?? []).filter(i => !deletes.pending.value.includes(i.id)).filter(i => !search.value || `${i.taskRef ?? ''} ${i.subject} ${i.preview}`.toLowerCase().includes(search.value.toLowerCase())))
const selectedId = computed(() => typeof route.params.itemId === 'string' ? route.params.itemId : null)
watch(selectedId, () => {
  // Leaving during approval or close unmounts the thread before it can
  // release the hold. Resume live refreshes for the new selection.
  if (planResolving.value) {
    planResolving.value = false
    void load()
  }
})
// A thread leaves Needs you once it's answered or replied to (D11), while
// the PM's turn is still running. Keep its conversation open so the turn
// streams in, until another item is picked.
const openThread = shallowRef<PlanThreadItem | null>(null)
watch(() => inbox.value?.needsYou.find(i => i.id === selectedId.value), (item) => {
  if (item?.type === 'plan_thread') openThread.value = item
}, { immediate: true })
const selected = computed<InboxItem | null>(() => {
  if (!inbox.value || !selectedId.value) return null
  return [...inbox.value.needsYou, ...inbox.value.activity, ...inbox.value.resolved].find(i => i.id === selectedId.value)
    ?? (openThread.value?.id === selectedId.value ? openThread.value : null)
})
const alreadyResolved = computed(() => selected.value !== null && selected.value.type !== 'activity' && !inbox.value?.needsYou.some(i => i.id === selected.value!.id))
watch(selected, async (item, previous) => {
  action.value = null
  text.value = ''
  actionError.value = null
  // Nothing selected (e.g. the last item was just resolved): nothing to show beside it
  if (!item) flyout.close()
  if (item?.type === 'plan_thread') {
    if (previous?.id !== item.id && (flyout.ref.value || flyout.epic.value)) await flyout.close()
    task.value = null
    return
  }
  const loadedTask = item ? await api.tasks.byRef(item.taskRef).catch(() => null) : null
  if (selected.value?.id !== item?.id) return
  task.value = loadedTask
  // A human review carries its evidence in the message (design/inbox.md)
  const slug = live.state.value.projects.find(p => p.id === task.value?.projectId)?.slug
  if (item?.type === 'human_review' && task.value && slug) {
    ;[evidence.value, reviews.value] = await Promise.all([
      api.tasks.evidence(slug, task.value.number).catch(() => []),
      api.tasks.reviews(slug, task.value.number).catch(() => [])
    ])
  } else {
    evidence.value = []
    reviews.value = []
  }
  // Following the selection, not a click of its own: no extra history entry.
  // Phones open the task as its own page instead.
  if (selected.value?.id !== item?.id) return
  if (item && showTask.value && !device.isMobile.value) flyout.open(item.taskRef, { replace: true })
}, { immediate: true })
// Capture before the request: plan.session can remove the row before it resolves.
// Hold refreshes through both the request and flyout close, as for approval.
function setPlanResolving(value: boolean) {
  planResolving.value = value
  if (value) resolutionPosition = items.value.findIndex(i => i.id === selectedId.value)
}
async function nextAfterPlanResolution() {
  planResolving.value = false
  const position = resolutionPosition
  await load()
  const remaining = inbox.value?.needsYou ?? []
  const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)]
  await router.replace(next ? `/inbox/${next.id}` : '/inbox')
}
const count = computed(() => (inbox.value?.count ?? 0) - (inbox.value?.needsYou.filter(i => deletes.pending.value.includes(i.id)).length ?? 0))
// Delete thread, from its row or its header: no confirmation, Undo instead.
// Deleting the selected thread moves on to the next item, as resolving does.
async function deleteThread(item: PlanThreadItem) {
  const position = items.value.findIndex(i => i.id === item.id)
  deletes.remove(item.sessionId, load)
  if (selectedId.value !== item.id) return
  if (openThread.value?.id === item.id) openThread.value = null
  await flyout.close()
  const remaining = items.value
  const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)]
  await router.replace(next ? `/inbox/${next.id}` : '/inbox')
}
function select(item: InboxItem) {
  void router.push(`/inbox/${item.id}`)
}
function toggleTask() {
  showTask.value = !showTask.value
  if (showTask.value && selected.value?.taskRef) flyout.open(selected.value.taskRef, { replace: true })
  else flyout.close()
}

const actions = computed(() => {
  if (!selected.value) return []
  switch (selected.value.type) {
    case 'human_review': return [{ value: 'approve', label: 'Approve and merge', icon: 'i-lucide-check' }, { value: 'request_changes', label: 'Request changes', icon: 'i-lucide-pencil' }]
    case 'question':
    case 'blocked': return [{ value: 'clarify', label: 'Clarify and continue', icon: 'i-lucide-message-circle' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-lucide-undo-2' }, { value: 'delete', label: 'Delete task', icon: 'i-lucide-trash-2' }]
    case 'failed': return [{ value: 'resolve', label: 'Retry', icon: 'i-lucide-rotate-ccw' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-lucide-undo-2' }, { value: 'delete', label: 'Delete task', icon: 'i-lucide-trash-2' }]
    default: return []
  }
})
const needsText = computed(() => action.value === 'request_changes' || action.value === 'clarify')
const placeholder = computed(() => {
  switch (action.value) {
    case 'request_changes': return `What should ${task.value?.developer?.name ?? 'the developer'} change?`
    case 'clarify': return 'Your answer or guidance for the developer'
    case 'delete': return 'Reason for deleting (optional)'
    case null: return `Reply to ${selected.value?.sender.name ?? 'the agent'}…`
    default: return 'Optional note'
  }
})
const submitLabel = computed(() => action.value ? (actions.value.find(a => a.value === action.value)?.label ?? 'Send') : '')

// Resolves false when not sent, so the composer keeps its images
async function submit(message: string): Promise<boolean> {
  if (!selected.value || selected.value.type === 'plan_thread') return false
  busy.value = true
  actionError.value = null
  try {
    if (!action.value) {
      if (task.value) await api.tasks.comment(live.state.value.projects.find(p => p.id === task.value!.projectId)!.slug, task.value.number, message)
    } else {
      const input: InboxActionInput = action.value === 'clarify'
        ? { action: 'clarify', text: message }
        : action.value === 'request_changes'
          ? { action: 'request_changes', text: message }
          : action.value === 'resolve'
            ? { action: 'resolve', to: resolveTo.value, ...(message && { text: message }) }
            : action.value === 'delete'
              ? { action: 'delete', ...(message && { text: message }) }
              : action.value === 'send_back' ? { action: 'send_back' } : { action: 'approve' }
      await api.inbox.act(selected.value.taskId, input)
      toast.add({ title: 'Done', description: submitLabel.value, color: 'success' })
    }
    const actedOn = selected.value
    const position = items.value.findIndex(i => i.id === actedOn.id)
    text.value = ''
    action.value = null
    await load()
    // Resolved: move on to the next item that needs you, or to the empty
    // state when that was the last one
    if (!inbox.value?.needsYou.some(i => i.id === actedOn.id)) {
      const remaining = inbox.value?.needsYou ?? []
      const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)]
      void router.replace(next ? `/inbox/${next.id}` : '/inbox')
    }
    return true
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    busy.value = false
  }
}
// On a phone the shell's header names the item and where it sits in the list
const mobileHeader = useMobileHeader()
watchEffect(() => {
  if (!device.isMobile.value || !selectedId.value) {
    mobileHeader.value = null
    return
  }
  const position = inbox.value?.needsYou.findIndex(i => i.id === selectedId.value) ?? -1
  mobileHeader.value = {
    title: selected.value?.type === 'plan_thread' ? selected.value.subject : selected.value?.taskRef ?? '',
    eyebrow: position >= 0 ? `Inbox · ${position + 1} of ${inbox.value!.needsYou.length}` : 'Inbox'
  }
})
onBeforeUnmount(() => {
  mobileHeader.value = null
})
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <!-- Phones get the list and the item as separate screens (design/mobile.md) -->
    <InboxMobile
      v-if="device.isMobile.value"
      v-model:tab="tab"
      v-model:search="search"
      v-model:action="action"
      v-model:resolve-to="resolveTo"
      v-model:text="text"
      :plan-thread="selected?.type === 'plan_thread' ? selected : null"
      :on-refresh="load"
      :inbox="inbox"
      :error="error"
      :items="items"
      :selected-id="selectedId"
      :selected="selected?.type === 'plan_thread' ? null : selected"
      :already-resolved="alreadyResolved"
      :task="task"
      :evidence="evidence"
      :reviews="reviews"
      :actions="actions"
      :placeholder="placeholder"
      :submit-label="submitLabel"
      :needs-text="needsText"
      :busy="busy"
      :action-error="actionError"
      :type-badge="typeBadge"
      :on-submit="submit"
      :on-retry="load"
    />
    <div
      v-else
      class="flex h-full min-h-0 max-md:flex-col"
    >
      <div class="flex w-[380px] shrink-0 flex-col border-e border-default max-md:max-h-[360px] max-md:w-full max-md:border-e-0 max-md:border-b">
        <!-- The tabs row lines up with the item and flyout headers (56px) -->
        <div class="flex h-14 shrink-0 items-center border-b border-default px-3">
          <UTabs
            v-model="tab"
            :items="[
              { label: `Inbox (${count})`, value: 'needsYou', icon: 'i-lucide-inbox' },
              { label: 'Activity', value: 'activity', icon: 'i-lucide-activity' },
              { label: `Resolved (${inbox?.resolved.length ?? 0})`, value: 'resolved', icon: 'i-lucide-circle-check' }
            ]"
            size="xs"
            :content="false"
            class="w-full"
          />
        </div>
        <div class="border-b border-default p-3">
          <UInput
            v-model="search"
            placeholder="Search"
            icon="i-lucide-search"
            size="sm"
            class="w-full"
          />
        </div>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          class="m-3"
          :actions="[{ label: 'Retry', onClick: load }]"
        />
        <div
          v-else-if="!inbox"
          class="flex flex-col gap-2 p-3"
        >
          <USkeleton
            v-for="i in 4"
            :key="i"
            class="h-16 w-full"
          />
        </div>
        <ul
          v-else
          class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <li
            v-for="item in items"
            :key="item.id"
            class="group relative"
          >
            <button
              type="button"
              :class="['flex w-full gap-2 border-b border-default px-3 py-2 text-start', selectedId === item.id && 'bg-elevated']"
              @click="select(item)"
            >
              <PlanThreadRow
                v-if="item.type === 'plan_thread'"
                :item="item"
              />
              <template v-else>
                <AgentAvatar
                  :name="item.sender.name"
                  size="xs"
                />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2 text-xs text-muted">
                    <span class="font-medium text-default">{{ item.sender.name }}</span>
                    <span class="ms-auto">{{ timeAgo(item.at) }}</span>
                  </span>
                  <span class="block truncate text-sm font-medium">{{ item.subject }}</span>
                  <span class="line-clamp-2 text-xs text-muted">{{ markdownToPlainText(item.preview) }}</span>
                  <span class="mt-1 flex items-center gap-2">
                    <UBadge
                      :label="typeBadge(item.type).label"
                      :color="typeBadge(item.type).color"
                      variant="subtle"
                      size="xs"
                    />
                    <span class="flex items-center gap-1 text-xs text-muted">
                      <span
                        class="size-2 rounded-full"
                        :style="{ background: item.project.thumbnailColor ?? '#64748b' }"
                      />{{ item.project.name }}
                    </span>
                  </span>
                </span>
              </template>
            </button>
            <UButton
              v-if="item.type === 'plan_thread'"
              icon="i-lucide-trash-2"
              variant="soft"
              color="error"
              size="xs"
              aria-label="Delete thread"
              title="Delete thread"
              class="absolute end-3 bottom-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              @click="deleteThread(item)"
            />
          </li>
          <li
            v-if="items.length === 0"
            class="p-6 text-center text-sm text-muted"
          >
            All clear. Nothing here right now.
          </li>
        </ul>
      </div>

      <InboxPlanThread
        v-if="selected?.type === 'plan_thread'"
        :key="selected.sessionId"
        :item="selected"
        @read="load"
        @approved="nextAfterPlanResolution"
        @approving="setPlanResolving"
        @delete="deleteThread(selected)"
      />
      <div
        v-else
        class="flex min-w-0 flex-1 flex-col"
      >
        <template v-if="selected">
          <header class="flex h-14 shrink-0 items-center gap-3 border-b border-default px-4">
            <AgentAvatar
              :name="selected.sender.name"
              size="sm"
            />
            <div class="min-w-0 flex-1">
              <h1 class="truncate text-sm font-medium">
                {{ selected.subject }}
              </h1>
              <div class="flex items-center gap-2 overflow-hidden text-xs whitespace-nowrap text-muted">
                <UBadge
                  :label="typeBadge(selected.type).label"
                  :color="typeBadge(selected.type).color"
                  variant="subtle"
                  size="xs"
                />
                <span>{{ selected.project.name }} · {{ selected.taskRef }}</span>
                <span>{{ selected.sender.name }} · {{ selected.sender.role }} · {{ timeAgo(selected.at) }}</span>
              </div>
            </div>
            <UButton
              label="Task details"
              variant="outline"
              color="neutral"
              size="sm"
              :aria-pressed="showTask"
              @click="toggleTask"
            />
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
            <div class="mx-auto flex max-w-[720px] flex-col gap-4">
              <UAlert
                v-if="selected.resolution"
                color="success"
                variant="subtle"
                icon="i-lucide-circle-check"
                title="Resolved"
                :description="selected.resolution"
              />
              <UAlert
                v-else-if="alreadyResolved"
                color="neutral"
                variant="subtle"
                title="Already resolved"
                description="This task changed status elsewhere."
              />
              <MarkdownText
                :text="selected.body"
                class="text-sm"
              />
              <a
                v-if="selected.prUrl"
                :href="selected.prUrl"
                target="_blank"
                rel="noopener"
                class="text-sm text-primary hover:underline"
              >Open PR</a>
              <template v-if="selected.type === 'human_review' && task">
                <div
                  v-if="task.gateChecks?.length"
                  class="flex flex-wrap gap-1"
                >
                  <UBadge
                    v-for="check in task.gateChecks"
                    :key="check.name"
                    :label="`✓ ${check.name}`"
                    color="success"
                    variant="subtle"
                    size="xs"
                  />
                </div>
                <EvidenceList
                  :evidence="evidence"
                  :criteria="task.acceptanceCriteria"
                  :reviews="reviews.length > 0 ? reviews : task.latestReview ? [task.latestReview] : []"
                />
              </template>
              <NuxtLink
                v-if="selected.type === 'activity'"
                :to="`/tasks/${selected.taskRef}`"
                class="text-sm text-primary hover:underline"
              >Open task</NuxtLink>
            </div>
          </div>
          <div
            v-if="selected.type !== 'activity' && !selected.resolution && !alreadyResolved"
            class="shrink-0 border-t border-default p-3"
          >
            <div class="mx-auto flex max-w-[720px] flex-col gap-2">
              <div
                role="radiogroup"
                aria-label="Quick actions"
                class="flex flex-wrap gap-1.5"
              >
                <UButton
                  v-for="a in actions"
                  :key="a.value"
                  :label="a.label"
                  :icon="a.icon"
                  size="xs"
                  role="radio"
                  :aria-checked="action === a.value"
                  :variant="action === a.value ? 'subtle' : 'outline'"
                  :color="a.value === 'delete' ? 'error' : action === a.value ? 'primary' : 'neutral'"
                  @click="action = action === a.value ? null : (a.value as InboxActionInput['action'])"
                />
                <USelectMenu
                  v-if="action === 'resolve'"
                  v-model="resolveTo"
                  :items="[{ label: 'In progress', value: 'in_progress' }, { label: 'Ready', value: 'ready' }, { label: 'Backlog', value: 'backlog' }]"
                  value-key="value"
                  size="xs"
                  :search-input="false"
                />
              </div>
              <UAlert
                v-if="actionError"
                color="error"
                variant="subtle"
                :title="actionError"
              />
              <PromptComposer
                v-model="text"
                :placeholder="placeholder"
                :submit-label="submitLabel"
                :submit-color="action === 'delete' ? 'error' : 'primary'"
                :allow-empty="action !== null && !needsText"
                :busy="busy"
                :project="selected.project.slug"
                @submit="submit"
              />
            </div>
          </div>
        </template>
        <div
          v-else
          class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted"
        >
          <template v-if="inbox && count === 0">
            <UIcon
              name="i-lucide-circle-check"
              class="size-8 text-success"
            />
            <span class="font-medium text-default">All clear</span>
            <span>Nothing needs you right now.</span>
          </template>
          <span v-else>Pick an item.</span>
        </div>
      </div>
      <TaskFlyout v-if="selected?.type !== 'plan_thread'" />
    </div>
  </UDashboardPanel>
</template>
