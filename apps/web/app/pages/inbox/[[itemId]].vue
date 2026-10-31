<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { InboxActionInput, TaskInboxItem, InboxItem, PlanThreadItem } from '@corral/contracts'
import { inboxActions } from '~/utils/inbox-actions'
import { actOnInboxItem, holdsInbox, useHeldInbox } from '~/queries/inbox'
import { keys } from '~/queries/keys'
import { commentOnTask, taskEvidenceQuery, taskQuery, taskReviewsQuery } from '~/queries/tasks'
import { inboxTypeBadge as typeBadge, timeAgo } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'
import { moveRadioSelection } from '~/utils/radio'

definePageMeta({ key: 'inbox' })

// The Inbox (design/inbox.md, D11): list, selected item, action tray, task flyout
const route = useRoute()
const router = useRouter()
const flyout = useTaskFlyout()
const toast = useToast()
const device = useDevice()
const deletes = usePlanThreadDelete()
useSeoMeta({ title: 'Inbox · Corral' })

const client = useQueryClient()
const list = useHeldInbox()
const inbox = list.inbox
const acting = useMutation({ ...actOnInboxItem, ...holdsInbox })
const commenting = useMutation({ ...commentOnTask, ...holdsInbox })
// A failed refetch keeps the list it has
const error = computed(() => inbox.value ? null : list.error.value?.message ?? null)
const tab = ref<'needsYou' | 'activity' | 'resolved'>('needsYou')
const search = ref('')
const action = ref<InboxActionInput['action'] | null>(null)
const resolveTo = ref<'backlog' | 'ready' | 'in_progress'>('in_progress')
const text = ref('')
const busy = ref(false)
const failedAction = ref<string | null>(null)
const showTask = ref(true)

const isHidden = (item: InboxItem) => deletes.pending.value.includes(item.id)
// In the server's order (newest first, D11), less threads waiting out their Undo
const items = computed<InboxItem[]>(() => (inbox.value?.[tab.value] ?? []).filter(i => !isHidden(i)).filter(i => !search.value || `${i.taskRef ?? ''} ${i.subject} ${i.preview}`.toLowerCase().includes(search.value.toLowerCase())))
const selectedId = computed(() => typeof route.params.itemId === 'string' ? route.params.itemId : null)
// Leaving during an action hands the list to the new selection
watch(selectedId, list.release)
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
    ?? (openThread.value?.id === selectedId.value ? { ...openThread.value, unread: false } : null)
})
const isOwnPane = (item: InboxItem | null) => item?.type === 'plan_thread' || item?.type === 'epic_review' || item?.type === 'release_notes' || item?.type === 'epic_conflict'
const isTaskItem = (item: InboxItem | null): item is TaskInboxItem => item?.taskId != null
// The key ties the task to the selection, so nothing of the last item shows
const taskRef = computed(() => isTaskItem(selected.value) ? selected.value.taskRef : null)
const taskResult = useQuery(computed(() => ({ ...taskQuery(taskRef.value ?? ''), enabled: taskRef.value !== null })))
const task = computed(() => taskResult.data.value ?? null)
// Human reviews show evidence; New artifacts need the files' real types
const address = computed(() => isTaskItem(selected.value) && (selected.value.type === 'human_review' || selected.value.newArtifacts?.length) && task.value ? { slug: selected.value.project.slug, number: task.value.number, ref: task.value.ref } : null)
const evidenceOptions = computed(() => ({ ...taskEvidenceQuery(address.value ?? { slug: '', number: 0, ref: '' }), enabled: address.value !== null }))
const reviewsOptions = computed(() => ({ ...taskReviewsQuery(address.value ?? { slug: '', number: 0, ref: '' }), enabled: address.value !== null && selected.value?.type === 'human_review' }))
const evidenceResult = useQuery(evidenceOptions)
const reviewsResult = useQuery(reviewsOptions)
const evidence = computed(() => evidenceResult.data.value ?? [])
const reviews = computed(() => reviewsResult.data.value ?? [])
const isSpike = computed(() => task.value?.type === 'spike')
const taskLoading = computed(() => taskRef.value !== null && taskResult.isPending.value)
// Stays until a fetch settles it, whatever refetches meanwhile. A query with
// data keeps showing it through a failed refetch.
const taskLoadFailed = computed(() => taskRef.value !== null && taskResult.isError.value && !task.value)
// Approval needs the task for its human-criteria check. The other actions don't.
const approveBlocked = computed(() => taskLoadFailed.value && action.value === 'approve')
const alreadyResolved = computed(() => selected.value !== null && selected.value.type !== 'activity' && !inbox.value?.needsYou.some(i => i.id === selected.value!.id))
const TASK_LOAD_ERROR = 'Couldn\'t load this task'
const actionError = computed(() => failedAction.value ?? (taskLoadFailed.value ? TASK_LOAD_ERROR : null))
function retryTask() {
  failedAction.value = null
  // Back to pending, for the loading state and a fresh failure
  if (taskRef.value) void client.resetQueries({ queryKey: keys.tasks.detail(taskRef.value), exact: true })
}
watch(() => selected.value?.id, async (_, previous) => {
  const item = selected.value
  text.value = ''
  busy.value = false
  resolveTo.value = 'in_progress'
  failedAction.value = null
  // A selection with nothing to show (e.g. the last item was just resolved).
  // Plain /inbox?task= has no selection to lose: its dock is a shared link.
  if (!item) {
    if (selectedId.value || previous) void flyout.close()
  } else if (isOwnPane(item)) {
    if (flyout.ref.value || flyout.epic.value) await flyout.close()
  } else if (item.taskRef && showTask.value && !device.isMobile.value) {
    // Following the selection, not a click of its own: no extra history entry.
    // Phones open the task as its own page instead.
    flyout.open(item.taskRef, { replace: true })
  }
}, { immediate: true })
const PREFETCH_LIMIT_MS = 1000
// Resolving moves to the item at the same position, or to the empty state when
// that was the last one. The held list still has the old position.
async function moveToNext() {
  const position = items.value.findIndex(i => i.id === selectedId.value)
  const remaining = (list.data.value?.needsYou ?? []).filter(i => !isHidden(i))
  const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)]
  // Arrive with its task, so the panes never show a skeleton, but don't let a
  // slow or failing task hold up the move
  const leaving = selectedId.value
  if (next?.taskRef) await Promise.race([client.prefetchQuery(taskQuery(next.taskRef)), new Promise(resolve => setTimeout(resolve, PREFETCH_LIMIT_MS))])
  // Picked another item or left meanwhile: that selection stands
  if (selectedId.value !== leaving) return
  await router.replace(itemRoute(next))
  list.release()
}
const count = computed(() => (inbox.value?.count ?? 0) - (inbox.value?.needsYou.filter(isHidden).length ?? 0))
// Delete thread, from its row or its header: no confirmation, Undo instead.
// Deleting the selected thread moves on to the next item, as resolving does.
async function deleteThread(item: PlanThreadItem) {
  const position = items.value.findIndex(i => i.id === item.id)
  deletes.remove(item.sessionId)
  if (selectedId.value !== item.id) return
  if (openThread.value?.id === item.id) openThread.value = null
  await flyout.close()
  const remaining = items.value
  const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)]
  await router.replace(itemRoute(next))
}
function itemRoute(item: InboxItem | undefined) {
  return {
    path: item ? `/inbox/${item.id}` : '/inbox',
    // Keep the dock mounted while its task changes.
    query: flyout.ref.value && isTaskItem(item ?? null) ? { task: item!.taskRef! } : {}
  }
}
function select(item: InboxItem) {
  void router.push(itemRoute(item))
}
function toggleTask() {
  showTask.value = !showTask.value
  if (showTask.value && selected.value?.taskRef) flyout.open(selected.value.taskRef, { replace: true })
  else flyout.close()
}

const actions = computed(() => selected.value && selected.value.type !== 'plan_thread' ? inboxActions(selected.value.type, task.value, taskLoading.value ? 'loading' : taskLoadFailed.value ? 'failed' : null) : [])
// Reset when the item or its type changes, including when its task loads.
watch([() => selected.value?.id, () => selected.value?.type, () => task.value?.type], () => {
  action.value = (actions.value[0]?.value as InboxActionInput['action'] | undefined) ?? null
}, { immediate: true })
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
const checkedHumanCriteria = ref<string[]>([])
watch(selectedId, () => {
  checkedHumanCriteria.value = []
})
const submitLabel = computed(() => action.value ? (actions.value.find(a => a.value === action.value)?.label ?? 'Send') : '')

// Resolves false when not sent, so the composer keeps its images
async function submit(message: string): Promise<boolean> {
  if (!selected.value || isOwnPane(selected.value)) return false
  if (taskLoading.value || approveBlocked.value) return false
  if (action.value === 'approve' && task.value?.acceptanceCriteria.some(c => c.checkedByHuman && !checkedHumanCriteria.value.includes(c.id))) {
    failedAction.value = 'Check each human criterion before approving.'
    return false
  }
  const actedOn = selected.value
  busy.value = true
  failedAction.value = null
  try {
    if (!action.value) {
      if (task.value) await commenting.mutateAsync({ task: { slug: actedOn.project.slug, number: task.value.number, ref: task.value.ref }, body: message })
    } else {
      const input: InboxActionInput = action.value === 'clarify'
        ? { action: 'clarify', text: message }
        : action.value === 'request_changes'
          ? { action: 'request_changes', text: message }
          : action.value === 'resolve'
            ? { action: 'resolve', to: resolveTo.value, ...(message && { text: message }) }
            : action.value === 'delete'
              ? { action: 'delete', ...(message && { text: message }) }
              : action.value === 'send_back' ? { action: 'send_back' } : { action: 'approve', text: message }
      const description = action.value === 'approve' && isSpike.value ? 'You accepted the findings' : submitLabel.value
      await acting.mutateAsync({ taskId: actedOn.taskId, input })
      toast.add({ title: 'Done', description, color: 'success' })
    }
    // A send finishing for an older selection leaves the new one alone
    if (selectedId.value !== actedOn.id) return true
    text.value = ''
    if (list.data.value?.needsYou.some(i => i.id === actedOn.id)) list.release()
    else await moveToNext()
    return true
  } catch (e) {
    if (selectedId.value === actedOn.id) failedAction.value = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    if (selectedId.value === actedOn.id) busy.value = false
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
    title: isOwnPane(selected.value) ? selected.value!.subject : selected.value?.taskRef ?? '',
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
    <InboxEpicReview
      v-if="device.isMobile.value && selected?.type === 'epic_review'"
      :key="selected.id"
      :item="selected"
      @resolved="moveToNext"
    />
    <InboxEpicConflict
      v-else-if="device.isMobile.value && selected?.type === 'epic_conflict'"
      :key="selected.id"
      :item="selected"
      @resolved="moveToNext"
    />
    <InboxMobile
      v-else-if="device.isMobile.value"
      v-model:checked-human-criteria="checkedHumanCriteria"
      v-model:tab="tab"
      v-model:search="search"
      v-model:action="action"
      v-model:resolve-to="resolveTo"
      v-model:text="text"
      :plan-thread="selected?.type === 'plan_thread' ? selected : null"
      :inbox="inbox"
      :error="error"
      :items="items"
      :selected-id="selectedId"
      :selected="selected?.type === 'plan_thread' || selected?.type === 'epic_review' || selected?.type === 'epic_conflict' ? null : selected"
      :already-resolved="alreadyResolved"
      :task="task"
      :is-spike="isSpike"
      :evidence="evidence"
      :reviews="reviews"
      :actions="actions"
      :placeholder="placeholder"
      :submit-label="submitLabel"
      :needs-text="needsText"
      :busy="busy || taskLoading"
      :approve-blocked="approveBlocked"
      :task-load-failed="taskLoadFailed"
      :action-error="actionError"
      :type-badge="typeBadge"
      :on-submit="submit"
      :on-retry="list.refetch"
      :on-retry-task="retryTask"
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
          :actions="[{ label: 'Retry', onClick: () => list.refetch() }]"
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
                <span
                  v-if="item.type === 'release_notes' && item.unread"
                  class="mt-2 size-2 shrink-0 rounded-full bg-primary"
                  aria-label="Unread"
                />
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
                  <span
                    v-if="item.type === 'release_notes'"
                    class="block font-mono text-xs text-muted"
                  >{{ item.fromSha ? `${item.fromSha}…` : '' }}{{ item.toSha }}</span>
                  <span class="mt-1 flex items-center gap-2">
                    <UBadge
                      :label="typeBadge(item.type).label"
                      :color="typeBadge(item.type).color"
                      variant="subtle"
                      size="xs"
                    />
                    <span class="flex items-center gap-1 text-xs text-muted">
                      <ProjectThumbnail
                        :project="item.project"
                        :size="16"
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

      <InboxEpicReview
        v-if="selected?.type === 'epic_review'"
        :key="selected.id"
        :item="selected"
        @resolved="moveToNext"
      />
      <InboxReleaseNotes
        v-else-if="selected?.type === 'release_notes'"
        :key="selected.id"
        :item="selected"
      />
      <InboxEpicConflict
        v-else-if="selected?.type === 'epic_conflict'"
        :key="selected.id"
        :item="selected"
        @resolved="moveToNext"
      />
      <InboxPlanThread
        v-else-if="selected?.type === 'plan_thread'"
        :key="selected.sessionId"
        :item="selected"
        @approved="moveToNext"
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
                <span class="flex items-center gap-1"><ProjectThumbnail
                  :project="selected.project"
                  :size="16"
                />{{ selected.project.name }} · {{ selected.taskRef }}</span>
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
          <!-- Keyed so the next item opens at its top -->
          <div
            :key="selected.id"
            class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
            data-testid="inbox-detail-scroller"
          >
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
              <InboxMessage
                :key="selected.id"
                :item="selected"
                :evidence="evidence"
                class="text-sm"
              />
              <a
                v-if="!isSpike && selected.prUrl"
                :href="selected.prUrl"
                target="_blank"
                rel="noopener"
                class="text-sm text-primary hover:underline"
              >Open PR</a>
              <template v-if="selected.type === 'human_review' && task">
                <div
                  v-if="!isSpike && task.gateChecks?.length"
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
                  v-model:checked="checkedHumanCriteria"
                  :evidence="evidence"
                  human-checklist
                  :criteria="task.acceptanceCriteria"
                  :reviews="reviews.length > 0 ? reviews : task.latestReview ? [task.latestReview] : []"
                />
              </template>
              <NuxtLink
                v-if="selected.type === 'activity'"
                :to="selected.epicId ? `/epics/${selected.epicId}` : `/tasks/${selected.taskRef}`"
                class="text-sm text-primary hover:underline"
              >{{ selected.epicId ? 'Open epic' : 'Open task' }}</NuxtLink>
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
                @keydown="moveRadioSelection"
              >
                <InboxDesignReviewLink :task="task" />
                <UButton
                  v-for="a in actions"
                  :key="a.value"
                  :label="a.label"
                  :icon="a.icon"
                  size="xs"
                  role="radio"
                  :aria-checked="action === a.value"
                  :tabindex="action === a.value ? 0 : -1"
                  :variant="action === a.value ? 'subtle' : 'outline'"
                  :color="a.value === 'delete' ? 'error' : action === a.value ? 'primary' : 'neutral'"
                  @click="action = (a.value as InboxActionInput['action'])"
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
                :actions="taskLoadFailed ? [{ label: 'Retry', onClick: retryTask }] : []"
              />
              <PromptComposer
                :key="selected.id"
                v-model="text"
                :placeholder="placeholder"
                :submit-label="submitLabel"
                :submit-color="action === 'delete' ? 'error' : 'primary'"
                :allow-empty="action !== null && !needsText"
                :busy="busy || taskLoading"
                :disabled="approveBlocked"
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
