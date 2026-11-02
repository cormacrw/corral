<script setup lang="ts">
import type { EpicActivityItem, EpicConflictItem, EpicReviewActionInput, EpicReviewItem, EpicReviewTaskRow, InboxActionInput, PullRequestDetail } from '@corral/contracts'
import { isTaskDone } from '@corral/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { reactive } from 'vue'
import { useDraft } from '~/composables/useDraft'
import type { InboxPanelContext } from '~/composables/useInboxPanel'
import { ApiError } from '~/queries/client'
import { epicReviewQuery, reviewEpic } from '~/queries/epics'
import { holdsInbox } from '~/queries/inbox'
import { keys } from '~/queries/keys'
import { plural, timeAgo } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'

// An epic in the Inbox, Option D (design/inbox.md): what's needed to decide up
// front, then tabs. An epic PR waiting on the human, what stopped an epic, and
// every read-only moment share this layout. On a phone (design/mobile.md) the
// actions and the composer move to the bottom bar.
type Item = EpicReviewItem | EpicConflictItem | EpicActivityItem
type Tab = 'overview' | 'tasks' | 'review' | 'pr' | 'diff' | 'message'
// `gone`: the item left the Inbox while open, so the panel stays on what the
// human was reading and nothing can be sent
const props = defineProps<{ item: Item, mobile?: boolean, gone?: boolean }>()
const emit = defineEmits<{ resolved: [] }>()

const client = useQueryClient()
const result = useQuery(computed(() => epicReviewQuery(props.item.epicId)))
const review = computed(() => result.data.value ?? null)
const loading = computed(() => result.isPending.value)
const refreshReview = () => client.resetQueries({ queryKey: keys.epics.review(props.item.epicId), exact: true })

// Before the review arrives, or if it can't, an item waiting on the human
// already has its tasks, so owed checks can still be ticked
const fromItem = computed<EpicReviewTaskRow[]>(() => props.item.type !== 'epic_review'
  ? []
  : props.item.tasks.map(({ task, evidence, humanReview, humanChecks }) => ({
      id: task.id, ref: task.ref, title: task.title, kind: task.kind, merged: isTaskDone(task),
      prNumber: task.pr?.number ?? null, prUrl: task.pr?.url ?? null, integratedCommit: task.submission?.integrated ?? null,
      reviewedBy: null, criteria: task.acceptanceCriteria, criteriaMet: task.acceptanceCriteria.filter(c => c.met === true).length,
      criteriaTotal: task.acceptanceCriteria.length, evidence, humanReview, humanChecks
    })))
const rows = computed(() => review.value?.tasks ?? fromItem.value)
const merged = computed(() => rows.value.filter(r => r.merged).length)
// Newest first. The item has them too, so Review works if the review can't load
const rounds = computed(() => review.value?.rounds ?? (props.item.type === 'epic_review' ? [...props.item.reviewRounds].reverse() : []))

const canAct = computed(() => props.item.type !== 'epic_activity' && !props.item.resolution)

// Local to the item, like task human checks: the server wants them on approval
const confirmedCriteria = ref<string[]>([])
const confirmedTasks = ref<string[]>([])
// A tick vouches for what was on screen, so a new head or changed checks need
// fresh ones. The item's tasks say what's owed, whether or not the review loaded.
const owedTasks = computed(() => props.item.type === 'epic_review' ? props.item.tasks : [])
const obligations = computed(() => owedTasks.value.reduce((n, t) => n + t.humanChecks.length + (t.humanReview ? 1 : 0), 0))
const confirmed = computed(() => owedTasks.value.reduce((n, t) => n + t.humanChecks.filter(id => confirmedCriteria.value.includes(id)).length + (t.humanReview && confirmedTasks.value.includes(t.task.id) ? 1 : 0), 0))
// The head the human is looking at. The item can update first, and approving
// must not vouch for a head whose diff and gates never reached the screen.
const viewedHead = computed(() => review.value?.headSha ?? (props.item.type === 'epic_activity' ? null : props.item.headSha))
const reviewed = computed(() => JSON.stringify([props.item.id, viewedHead.value, owedTasks.value.map(t => [
  t.task.id, t.humanReview, t.humanChecks, t.task.acceptanceCriteria.filter(c => t.humanChecks.includes(c.id)).map(c => c.text)
])]))
watch(reviewed, () => {
  confirmedCriteria.value = []
  confirmedTasks.value = []
})

const tab = ref<Tab>('overview')
const diffView = ref<'since' | 'whole'>('whole')
function seeChanges() {
  diffView.value = 'since'
  tab.value = 'diff'
}

const reviewing = useMutation({ ...reviewEpic, ...holdsInbox })
const busy = computed(() => reviewing.isPending.value || !!props.gone)
const action = ref<InboxActionInput['action'] | null>(null)
const refused = ref<string | null>(null)
const moved = 'This parent changed while you had it open. Check the refreshed review, then try again.'
const failure = computed(() => props.gone ? moved : refused.value)
// A draft, so what was typed outlives the panel
const draftKey = computed(() => `inbox:${props.item.id}`)
const text = useDraft(draftKey)
const REFUSED: Record<string, string> = {
  epic_review_changed: moved,
  epic_pr_changed: 'The parent PR changed on GitHub or was closed. Check the refreshed review, then try again.',
  human_checks_unconfirmed: 'The human checks changed. Tick them on the Tasks tab, then approve.',
  epic_decision_changed: 'This decision has already been answered, or it changed. Check the refreshed item.'
}

// Resolves false when not sent, so the composer keeps what was typed
async function send(input: EpicReviewActionInput): Promise<boolean> {
  refused.value = null
  try {
    await reviewing.mutateAsync({ id: props.item.epicId, input })
    text.value = ''
    emit('resolved')
    return true
  } catch (e) {
    const stale = e instanceof ApiError && e.status === 409
    const constraint = stale ? (e.body as { constraint?: string } | null)?.constraint : undefined
    refused.value = (constraint && REFUSED[constraint]) ?? (e instanceof Error ? e.message : String(e))
    if (constraint === 'human_checks_unconfirmed') tab.value = 'tasks'
    if (stale) await Promise.all([client.invalidateQueries({ queryKey: keys.inbox() }), client.invalidateQueries({ queryKey: keys.epics.detail(props.item.epicId) })])
    return false
  }
}

function approve() {
  const left = obligations.value - confirmed.value
  if (left > 0) {
    tab.value = 'tasks'
    refused.value = `${plural(left, 'human check')} left. Tick ${left === 1 ? 'it' : 'them'} here, then approve.`
    return Promise.resolve(false)
  }
  return send({ action: 'approve', headSha: viewedHead.value!, confirmedCriteria: confirmedCriteria.value, confirmedTasks: confirmedTasks.value })
}
watch(confirmed, () => {
  if (confirmed.value === obligations.value) refused.value = null
})

const decision = computed(() => props.item.type === 'epic_conflict' ? props.item.decision ?? null : null)
const actions = computed(() => {
  if (props.item.type === 'epic_review') {
    return [
      { value: 'approve', label: 'Approve parent', icon: 'i-lucide-check' },
      { value: 'request_changes', label: 'Request changes', icon: 'i-lucide-message-square-warning' }
    ]
  }
  if (props.item.type !== 'epic_conflict') return []
  return decision.value
    ? [{ value: 'clarify', label: 'Answer in your own words', icon: 'i-lucide-message-circle-reply' }]
    : [{ value: 'retry', label: 'Retry', icon: 'i-lucide-rotate-cw' }]
})
const opensComposer = (value: string | null) => value === 'request_changes' || value === 'clarify'

async function act(value: InboxActionInput['action']): Promise<boolean> {
  refused.value = null
  if (opensComposer(value)) {
    action.value = value
    return false
  }
  action.value = value
  const sent = value === 'approve' ? await approve() : await send({ action: 'rebase', headSha: viewedHead.value! })
  action.value = null
  return sent
}
// Only an action the human chose sends anything
function submit(message: string) {
  if (action.value === 'clarify') return send({ action: 'decide', headSha: viewedHead.value!, text: message })
  if (action.value === 'request_changes') return send({ action: 'request_changes', headSha: viewedHead.value!, text: message })
  return Promise.resolve(false)
}
const ctx = reactive({
  item: computed(() => props.item), task: null, evidence: [], reviews: [], alreadyResolved: false,
  taskLoading: false, taskLoadFailed: false, evidenceLoading: false, actions, action, resolveTo: 'in_progress', text,
  draftKey, busy, actionError: failure,
  placeholder: computed(() => action.value === 'clarify' ? 'Your answer' : 'What should change? It becomes a fix task in the parent'),
  submitLabel: computed(() => action.value === 'clarify' ? 'Send answer' : 'Request changes'),
  needsText: true, tab: 'overview', checkedHumanCriteria: [], taskOpen: false,
  composerChosen: computed(() => opensComposer(action.value)),
  submit, act,
  setAction: (value: InboxActionInput['action'] | null) => {
    action.value = value
    refused.value = null
  },
  // Closes the composer, and on a phone a draft alone would keep it open
  cancelAction: () => {
    action.value = null
    refused.value = null
    text.value = ''
  },
  setText: (value: string) => {
    text.value = value
  },
  setResolveTo: () => {}, setTab: () => {}, setCheckedHumanCriteria: () => {}, retryTask: () => {}, toggleTask: () => {}
}) as unknown as InboxPanelContext

const kind = computed(() => {
  const { item } = props
  if (item.resolution) return { label: 'Resolved', icon: 'i-lucide-circle-check', color: 'text-success' }
  if (item.type === 'epic_review') return { label: 'Parent review', icon: 'i-lucide-git-pull-request', color: 'text-primary' }
  if (item.type === 'epic_conflict') {
    if (item.stopped) return { label: item.stopped.fix === 'ci' || item.stopped.fix === 'review' ? 'Fix stopped' : 'Rebase stopped', icon: 'i-lucide-octagon-pause', color: 'text-error' }
    return item.decision
      ? { label: 'Rebase decision', icon: 'i-lucide-circle-help', color: 'text-info' }
      : { label: 'Parent conflict', icon: 'i-lucide-git-merge', color: 'text-error' }
  }
  return { label: 'Parent PR', icon: 'i-lucide-activity', color: 'text-muted' }
})
const tldr = computed(() => {
  const first = props.item.body.split(/\n\s*\n/).find(p => p.trim() && !p.trim().startsWith('#')) ?? props.item.body
  const plain = markdownToPlainText(first).replace(/\s+/g, ' ').trim()
  return plain.length > 180 ? `${plain.slice(0, 177).trimEnd()}…` : plain
})

// What the review said about this head. A reviewer sends the item only when
// integration was approved: a review that stopped or a refused merge comes from
// Corral, and an older round's approval says nothing about them.
const verdict = computed(() => {
  const round = rounds.value.find(r => r.headSha === viewedHead.value)
  if (round?.verdict === 'changes_requested') return { text: 'requested changes', name: round.reviewer.name, ok: false }
  if (props.item.sender.role !== 'reviewer') return { text: 'No reviewer approval on this head', name: null, ok: false }
  return { text: 'approved the parent', name: round?.reviewer.name ?? props.item.sender.name, ok: true }
})
const gates = computed(() => review.value?.gateChecks ?? [])
const gatesPassed = computed(() => gates.value.length > 0 && gates.value.every(g => g.conclusion === 'success'))
const saw = computed(() => {
  if (!review.value || rows.value.length === 0) return null
  return review.value.seenByHuman === rows.value.length ? 'You saw all' : `You saw ${review.value.seenByHuman} of ${rows.value.length}`
})
const target = computed(() => review.value?.targetBranch ?? (props.item.type === 'epic_conflict' ? props.item.targetBranch : null))
// A note under the actions, because this one reaches the target branch
const approving = computed(() => {
  const name = target.value ?? 'the target branch'
  const moved = review.value?.targetMovedBy ?? 0
  if (review.value?.conflictPending) return `This parent conflicts with ${name}. Approving sends the conflict to a developer, then runs CI and squash-merges.`
  return moved > 0
    ? `${name} has moved ${plural(moved, 'commit')}. Approving rebases onto it, runs CI and squash-merges.`
    : `Approving runs CI and squash-merges into ${name}.`
})
const readOnlyNote = computed(() => {
  if (props.item.type !== 'epic_activity') return ''
  return props.item.resolution ?? 'For your information. Nothing to do.'
})

const conflictTask = computed(() => props.item.type === 'epic_activity' && props.item.event === 'conflict' ? review.value?.conflictTaskRef ?? null : null)
const prLabel = computed(() => review.value?.pr ? `Parent PR #${review.value.pr.number}` : 'Parent PR')
const prUrl = computed(() => props.item.prUrl)

const tabs = computed(() => {
  const pr = review.value?.pr
  return [
    { label: 'Overview', value: 'overview' },
    ...(rows.value.length || loading.value ? [{ label: rows.value.length ? `Tasks ${merged.value}/${rows.value.length}` : 'Tasks', value: 'tasks' }] : []),
    ...(rounds.value.length || props.item.type === 'epic_review' || loading.value ? [{ label: 'Review', value: 'review' }] : []),
    ...(pr || loading.value ? [{ label: 'PR description', value: 'pr' }, { label: pr ? `Code diff ${pr.totalFiles}` : 'Code diff', value: 'diff' }] : []),
    { label: 'Message', value: 'message' }
  ]
})
const openTab = computed(() => tabs.value.some(t => t.value === tab.value) ? tab.value : 'overview')

// The Code diff tab's two views; a first review has only the whole epic
// Read-only moments are history, so what's changed since doesn't apply to them
const feedback = computed(() => canAct.value ? review.value?.lastFeedback ?? null : null)
const sinceUnavailable = computed(() => !!feedback.value && (!feedback.value.diffUrl || (feedback.value.truncated && feedback.value.files.length === 0)))
const skeleton = computed(() => loading.value && (['pr', 'diff'].includes(openTab.value)
  || (openTab.value === 'overview' && props.item.type !== 'epic_conflict')
  || (openTab.value === 'tasks' && !rows.value.length)
  || (openTab.value === 'review' && !rounds.value.length)))
const showing = computed<'since' | 'whole'>(() => feedback.value ? diffView.value : 'whole')
const diff = computed<PullRequestDetail | null>(() => {
  const pr = review.value?.pr ?? null
  if (!pr || showing.value === 'whole' || !feedback.value) return pr
  const { files, totalFiles, truncated } = feedback.value
  return { ...pr, files, totalFiles, truncated }
})
</script>

<template>
  <section
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    aria-label="Parent review"
    data-testid="inbox-epic-panel"
  >
    <div :class="['flex max-h-[60%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-default', mobile ? 'p-3' : 'px-5 pt-4 pb-3']">
      <p
        class="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted"
        data-testid="inbox-meta"
      >
        <UIcon
          :name="kind.icon"
          :class="['size-3.5 shrink-0', kind.color]"
        />
        <span class="font-medium text-default">{{ kind.label }}</span>
        <span aria-hidden="true">·</span>
        <ProjectThumbnail
          :project="item.project"
          :size="14"
        />
        <span class="truncate">{{ item.project.name }} · {{ item.sender.name }} · {{ timeAgo(item.at) }}</span>
      </p>
      <h1 class="text-lg leading-tight font-semibold break-words text-highlighted">
        <NuxtLink
          :to="`/epics/${item.epicId}`"
          class="hover:underline"
        >
          {{ item.subject }}
        </NuxtLink>
      </h1>
      <InboxMessage
        v-if="item.message"
        :key="item.id"
        :item="item"
        :evidence="rows.flatMap(r => r.evidence)"
        summary
      />
      <p
        v-else
        class="line-clamp-2 text-sm"
      >
        <span class="font-medium">TL;DR</span> <TaskRefText
          :text="tldr"
          class="text-muted"
        />
      </p>
      <div
        v-if="item.type === 'epic_review'"
        class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted"
        data-testid="inbox-epic-verdict"
      >
        <span
          class="flex items-center gap-1.5"
          data-testid="inbox-epic-reviewer"
        >
          <UIcon
            :name="verdict.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
            :class="['size-4 shrink-0', verdict.ok ? 'text-success' : 'text-warning']"
          />
          <span><span
            v-if="verdict.name"
            class="font-medium text-default"
          >{{ verdict.name }}</span>{{ verdict.name ? ' ' : '' }}{{ verdict.text }}</span>
        </span>
        <USkeleton
          v-if="loading"
          class="h-5 w-56"
          data-testid="inbox-verdict-loading"
        />
        <template v-else-if="review">
          <template v-if="gates.length">
            <span aria-hidden="true">·</span>
            <span>{{ gates.map(g => g.name).join(', ') }} {{ gatesPassed ? 'passed' : 'not passed yet' }}</span>
          </template>
          <span aria-hidden="true">·</span>
          <span>{{ merged }} of {{ rows.length }} {{ rows.length === 1 ? 'task' : 'tasks' }} merged</span>
          <template v-if="saw">
            <span aria-hidden="true">·</span>
            <span class="font-medium text-default">{{ saw }}</span>
          </template>
        </template>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div
          v-if="canAct && !mobile"
          class="flex flex-wrap items-center gap-2"
          data-testid="inbox-actions"
        >
          <UButton
            v-for="(a, i) in actions"
            :key="a.value"
            :label="a.label"
            :icon="a.icon"
            size="sm"
            :color="i === 0 ? 'primary' : 'neutral'"
            :variant="i === 0 ? 'solid' : action === a.value ? 'subtle' : 'outline'"
            :loading="busy && action === a.value"
            :disabled="busy"
            :data-testid="i === 0 ? 'inbox-primary' : undefined"
            @click="act(a.value as InboxActionInput['action'])"
          />
        </div>
        <p
          v-else-if="!canAct"
          class="text-sm text-muted"
          data-testid="inbox-read-only"
        >
          {{ item.type === 'epic_activity' ? readOnlyNote : item.resolution }}
        </p>
        <UButton
          v-if="prUrl"
          :to="prUrl"
          target="_blank"
          :label="prLabel"
          icon="i-lucide-git-pull-request"
          color="neutral"
          variant="ghost"
          size="sm"
        />
      </div>
      <p
        v-if="canAct && item.type === 'epic_review'"
        class="text-xs text-muted"
        data-testid="inbox-epic-approving"
      >
        {{ approving }}
      </p>
      <UAlert
        v-if="failure && !mobile && !ctx.composerChosen"
        color="error"
        variant="subtle"
        :title="failure"
      />
    </div>
    <UTabs
      :model-value="openTab"
      :items="tabs"
      :content="false"
      variant="link"
      size="sm"
      :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0' }"
      :class="['shrink-0', mobile ? 'px-1' : 'px-3']"
      data-testid="inbox-tabs"
      @update:model-value="tab = $event as Tab"
    />
    <div
      :class="['min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain', mobile ? 'p-3' : 'p-5']"
      data-testid="inbox-detail-scroller"
    >
      <div
        v-if="skeleton"
        class="flex flex-col gap-3"
        data-testid="inbox-epic-loading"
      >
        <USkeleton class="h-5 w-72 max-w-full" />
        <USkeleton class="h-32 w-full" />
      </div>
      <div
        v-else-if="openTab === 'overview'"
        class="flex min-w-0 flex-col gap-4"
      >
        <UAlert
          v-if="result.isError.value && !review"
          color="error"
          variant="subtle"
          title="Couldn't load this parent's review"
          :description="result.error.value?.message"
          :actions="[{ label: 'Retry', onClick: refreshReview }]"
          data-testid="inbox-epic-error"
        />
        <InboxEpicOverview
          :item="item"
          :review="review"
          :rows="rows"
          :rounds="rounds"
          :feedback="feedback"
          :since-unavailable="sinceUnavailable"
          :conflict-task="conflictTask"
          :mobile="mobile"
          @see-changes="seeChanges"
        />
      </div>
      <InboxEpicTasks
        v-else-if="openTab === 'tasks'"
        v-model:confirmed-criteria="confirmedCriteria"
        v-model:confirmed-tasks="confirmedTasks"
        :rows="rows"
        :can-tick="canAct"
        :obligations="obligations"
        :confirmed="confirmed"
      />
      <InboxEpicRounds
        v-else-if="openTab === 'review' && rounds.length"
        :rounds="rounds"
      />
      <div
        v-else-if="openTab === 'pr' && review?.pr"
        class="flex flex-col gap-3"
        data-testid="inbox-pr-description"
      >
        <div class="text-sm text-muted">
          <p class="font-medium text-default">
            #{{ review.pr.number }} {{ review.pr.title }}
          </p>
          <p class="truncate">
            {{ review.pr.headBranch }} → {{ review.pr.baseBranch }}
          </p>
        </div>
        <MarkdownText
          v-if="review.pr.body"
          :text="review.pr.body"
          class="text-sm"
        />
        <p
          v-else
          class="text-sm text-muted"
        >
          This PR has no description.
        </p>
      </div>
      <div
        v-else-if="openTab === 'diff' && diff"
        class="flex flex-col gap-3"
      >
        <div
          v-if="feedback"
          class="flex flex-wrap gap-1"
          role="group"
          aria-label="Which changes to show"
          data-testid="inbox-diff-view"
        >
          <UButton
            label="Since your last review"
            size="xs"
            :color="showing === 'since' ? 'primary' : 'neutral'"
            :variant="showing === 'since' ? 'subtle' : 'ghost'"
            :aria-pressed="showing === 'since'"
            @click="diffView = 'since'"
          />
          <UButton
            label="Whole parent"
            size="xs"
            :color="showing === 'whole' ? 'primary' : 'neutral'"
            :variant="showing === 'whole' ? 'subtle' : 'ghost'"
            :aria-pressed="showing === 'whole'"
            @click="diffView = 'whole'"
          />
        </div>
        <UAlert
          v-if="showing === 'since' && sinceUnavailable"
          color="warning"
          variant="subtle"
          title="Couldn't work out what changed since your review"
          :actions="feedback?.diffUrl ? [{ label: 'Compare on GitHub', to: feedback.diffUrl, target: '_blank', trailingIcon: 'i-lucide-arrow-up-right' }] : []"
          data-testid="inbox-since-unavailable"
        />
        <p
          v-else-if="showing === 'since' && diff.totalFiles === 0"
          class="text-sm text-muted"
        >
          Nothing has changed since the head you reviewed.
        </p>
        <InboxPanelDiff
          v-else
          :key="showing"
          :pr="diff"
          :github-url="showing === 'since' ? feedback?.diffUrl ?? undefined : undefined"
        />
      </div>
      <MarkdownText
        v-else-if="openTab === 'message' || openTab === 'review'"
        :text="item.body"
        class="text-sm break-words"
      />
    </div>
    <InboxPanelThumbBar
      v-if="canAct && mobile"
      :ctx="ctx"
      approve-label="Approve parent"
      :reply="false"
    />
    <div
      v-else-if="canAct && ctx.composerChosen"
      class="shrink-0 border-t border-default p-3"
    >
      <InboxPanelTray :ctx="ctx" />
    </div>
  </section>
</template>
