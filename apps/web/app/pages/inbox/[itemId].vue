<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { InboxActionInput, TaskInboxItem } from '@corral/contracts'
import { reactive } from 'vue'
import { actionOpensComposer, type InboxPanelContext, type InboxPanelTab, type ResolveTo } from '~/composables/useInboxPanel'
import { isOwnPane, isTaskItem, useInboxView } from '~/composables/useInboxView'
import { inboxActions } from '~/utils/inbox-actions'
import { actOnInboxItem, holdsInbox } from '~/queries/inbox'
import { keys } from '~/queries/keys'
import { commentOnTask, taskEvidenceQuery, taskQuery, taskReviewsQuery } from '~/queries/tasks'

// The selected Inbox item (design/inbox.md): its panes, action tray and
// composer. Nuxt keys this page by its path, so the next item is a new instance
// with no draft, checked criteria or error left over.
const toast = useToast()
const device = useDevice()
const flyout = useTaskFlyout()
const { list, inbox, error, selected, selectedId, toggleTask, moveToNext, deleteThread } = useInboxView()

const client = useQueryClient()
const acting = useMutation({ ...actOnInboxItem, ...holdsInbox })
const commenting = useMutation({ ...commentOnTask, ...holdsInbox })
const action = ref<InboxActionInput['action'] | null>(null)
const resolveTo = ref<ResolveTo>('in_progress')
const text = ref('')
const busy = ref(false)
const panelView = ref<{ send: () => Promise<boolean> } | null>(null)
let quickActionPending = false
const failedAction = ref<string | null>(null)
const checkedHumanCriteria = ref<string[]>([])
const tab = ref<InboxPanelTab>('overview')

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
const HUMAN_CHECK_ERROR = 'Tick each human check before approving.'
watch(checkedHumanCriteria, () => {
  if (failedAction.value === HUMAN_CHECK_ERROR) failedAction.value = null
})
function retryTask() {
  failedAction.value = null
  // Back to pending, for the loading state and a fresh failure
  if (taskRef.value) void client.resetQueries({ queryKey: keys.tasks.detail(taskRef.value), exact: true })
}

const actions = computed(() => selected.value && selected.value.type !== 'plan_thread' ? inboxActions(selected.value.type, task.value, taskLoading.value ? 'loading' : taskLoadFailed.value ? 'failed' : null) : [])
// Reset when the item or its type changes, including when its task loads. The
// composer replies until an action is picked; on a phone a question opens on Answer.
const defaultAction = () => device.isMobile.value && selected.value?.type === 'question' ? 'clarify' : null
watch([() => selected.value?.id, () => selected.value?.type, () => task.value?.type], () => {
  action.value = defaultAction()
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
const submitLabel = computed(() => action.value ? (actions.value.find(a => a.value === action.value)?.label ?? 'Send') : '')

// Resolves false when not sent, so the composer keeps its images
async function submit(message: string): Promise<boolean> {
  if (!selected.value || isOwnPane(selected.value)) return false
  if (taskLoading.value || approveBlocked.value) return false
  if (action.value === 'approve' && task.value?.acceptanceCriteria.some(c => c.checkedByHuman && !checkedHumanCriteria.value.includes(c.id))) {
    failedAction.value = HUMAN_CHECK_ERROR
    tab.value = 'criteria'
    return false
  }
  const actedOn = selected.value
  busy.value = true
  failedAction.value = null
  try {
    if (!action.value) {
      await commenting.mutateAsync({ task: { id: actedOn.taskId, slug: actedOn.project.slug, number: Number(actedOn.taskRef.split('-').at(-1)), ref: actedOn.taskRef }, body: message })
      toast.add({ title: 'Done', description: 'Reply sent', color: 'success' })
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
    if (list.data.value?.needsYou.some(i => i.id === actedOn.id)) {
      action.value = defaultAction()
      list.release()
    } else await moveToNext()
    return true
  } catch (e) {
    if (selectedId.value === actedOn.id) failedAction.value = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    if (selectedId.value === actedOn.id) busy.value = false
  }
}

// One click: an action sent from the panel. If it wasn't, the composer goes
// back to replying, with the draft kept.
async function act(value: InboxActionInput['action']) {
  if (busy.value || quickActionPending) return false
  failedAction.value = null
  action.value = value
  if (actionOpensComposer(value)) return false
  const actedOn = selectedId.value
  quickActionPending = true
  try {
    const sent = await panelView.value?.send() ?? false
    if (!sent && selectedId.value === actedOn) action.value = null
    return sent
  } finally {
    quickActionPending = false
  }
}
const panel = reactive({
  item: computed(() => selected.value as TaskInboxItem),
  task, evidence, reviews, alreadyResolved, taskLoading, taskLoadFailed,
  evidenceLoading: computed(() => address.value !== null && evidenceResult.isPending.value),
  actions, action, resolveTo, text, busy, actionError: failedAction, placeholder, submitLabel, needsText, tab, checkedHumanCriteria,
  composerChosen: computed(() => action.value !== null && actionOpensComposer(action.value)),
  taskOpen: computed(() => flyout.ref.value !== null),
  submit, act, retryTask, toggleTask,
  setAction: (value: InboxActionInput['action'] | null) => {
    action.value = value
    failedAction.value = null
  },
  setText: (value: string) => {
    text.value = value
  },
  setResolveTo: (value: ResolveTo) => {
    resolveTo.value = value
  },
  setTab: (value: InboxPanelTab) => {
    tab.value = value
  },
  setCheckedHumanCriteria: (value: string[]) => {
    checkedHumanCriteria.value = value
  }
}) as InboxPanelContext
</script>

<template>
  <InboxEpicReview
    v-if="selected?.type === 'epic_review'"
    :item="selected"
    @resolved="moveToNext"
  />
  <InboxEpicConflict
    v-else-if="selected?.type === 'epic_conflict'"
    :item="selected"
    @resolved="moveToNext"
  />
  <InboxMobileItem
    v-else-if="device.isMobile.value"
    ref="panelView"
    :plan-thread="selected?.type === 'plan_thread' ? selected : null"
    :inbox="inbox"
    :error="error"
    :selected="selected?.type === 'plan_thread' ? null : selected"
    :ctx="panel"
    :on-retry="list.refetch"
  />
  <InboxReleaseNotes
    v-else-if="selected?.type === 'release_notes'"
    :item="selected"
  />
  <InboxPlanThread
    v-else-if="selected?.type === 'plan_thread'"
    :item="selected"
    @approved="moveToNext"
    @delete="deleteThread(selected)"
  />
  <InboxPanel
    v-else-if="selected"
    ref="panelView"
    :ctx="panel"
  />
  <div
    v-else
    class="flex min-w-0 flex-1 flex-col"
  >
    <InboxEmpty />
  </div>
</template>
