<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { InboxActionInput } from '@corral/contracts'
import { isOwnPane, isTaskItem, useInboxView } from '~/composables/useInboxView'
import { inboxActions } from '~/utils/inbox-actions'
import { actOnInboxItem, holdsInbox } from '~/queries/inbox'
import { keys } from '~/queries/keys'
import { commentOnTask, taskEvidenceQuery, taskQuery, taskReviewsQuery } from '~/queries/tasks'
import { inboxTypeBadge as typeBadge, timeAgo } from '~/utils/labels'
import { moveRadioSelection } from '~/utils/radio'

// The selected Inbox item (design/inbox.md): its panes, action tray and
// composer. Nuxt keys this page by its path, so the next item is a new instance
// with no draft, checked criteria or error left over.
const toast = useToast()
const device = useDevice()
const { list, inbox, error, selected, selectedId, showTask, toggleTask, moveToNext, deleteThread } = useInboxView()

const client = useQueryClient()
const acting = useMutation({ ...actOnInboxItem, ...holdsInbox })
const commenting = useMutation({ ...commentOnTask, ...holdsInbox })
const action = ref<InboxActionInput['action'] | null>(null)
const resolveTo = ref<'backlog' | 'ready' | 'in_progress'>('in_progress')
const text = ref('')
const busy = ref(false)
const failedAction = ref<string | null>(null)
const checkedHumanCriteria = ref<string[]>([])

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
      if (task.value) await commenting.mutateAsync({ task: { id: task.value.id, slug: actedOn.project.slug, number: task.value.number, ref: task.value.ref }, body: message })
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
    v-model:checked-human-criteria="checkedHumanCriteria"
    v-model:action="action"
    v-model:resolve-to="resolveTo"
    v-model:text="text"
    :plan-thread="selected?.type === 'plan_thread' ? selected : null"
    :inbox="inbox"
    :error="error"
    :selected="selected?.type === 'plan_thread' ? null : selected"
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
      <div
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
    <InboxEmpty v-else />
  </div>
</template>
