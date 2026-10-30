<script setup lang="ts">
import type { EpicInboxItem, EpicReview, Evidence, InboxActionInput } from '@corral/contracts'
import { actionNeedsText, type InboxPanelContext } from '~/composables/useInboxPanel'
import { EPIC_REVIEW_MODE, timeAgo } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'

// An epic PR in the Inbox (COR-190, D11, D23), in the same layout as a task's
// panel: the TL;DR, the verdict and the actions on top, then tabs. The human
// judges the feature as a whole here: the integration verdict, how far each
// task was seen and the combined diff. On a phone the actions move to the
// bar of large touch targets at the bottom of the screen.
const props = defineProps<{ item: EpicInboxItem, review: EpicReview | null, ctx: InboxPanelContext, mobile?: boolean }>()
const flyout = useTaskFlyout()
const tab = ref('overview')
const scope = ref<'all' | 'since'>('all')
const viewing = ref<Evidence | null>(null)
watch(() => props.item.id, () => {
  tab.value = 'overview'
  scope.value = 'all'
  viewing.value = null
})

const latest = computed(() => props.review?.rounds[0] ?? null)
const canAct = computed(() => props.ctx.actions.length > 0)
const merged = computed(() => props.review?.tasks.filter(t => t.merged).length ?? 0)
const seen = computed(() => props.review?.tasks.filter(t => t.reviewedBy === 'human').length ?? 0)
const total = computed(() => props.review?.tasks.length ?? 0)
const additions = computed(() => props.review?.pr.files.reduce((n, f) => n + f.additions, 0) ?? 0)
const deletions = computed(() => props.review?.pr.files.reduce((n, f) => n + f.deletions, 0) ?? 0)
const notes = computed(() => latest.value?.findings.filter(f => f.level === 'note') ?? [])
const shots = computed(() => (props.review?.tasks ?? []).flatMap(t => t.evidence.map(evidence => ({ evidence, ref: t.ref }))))
const target = computed(() => props.review?.targetBranch ?? 'the target branch')
const prNumber = computed(() => props.review?.pr.number ?? props.item.prUrl.match(/\/pull\/(\d+)/)?.[1])
const fileCount = computed(() => props.review?.pr.files.length ?? 0)

const kind = computed(() => {
  if (props.item.resolution) return { label: 'Resolved', icon: 'i-lucide-circle-check', color: 'text-success' }
  switch (props.item.event) {
    case 'conflict': return { label: 'Epic PR conflict', icon: 'i-lucide-triangle-alert', color: 'text-warning' }
    case 'merged': return { label: 'Epic PR merged', icon: 'i-lucide-git-merge', color: 'text-success' }
    case 'opened': return { label: 'Epic PR opened', icon: 'i-lucide-git-pull-request-arrow', color: 'text-muted' }
    default: return { label: 'Epic review', icon: 'i-lucide-git-pull-request-arrow', color: 'text-primary' }
  }
})
const ask = computed(() => {
  if (props.item.resolution) return props.item.resolution
  if (props.ctx.alreadyResolved) return 'Already resolved elsewhere. Nothing to do.'
  return 'For your information. Nothing to do.'
})
const tldr = computed(() => {
  const first = props.item.body.split(/\n\s*\n/).find(p => p.trim()) ?? props.item.body
  return markdownToPlainText(first).replace(/\s+/g, ' ').trim()
})
// What approving does, because here it lands on the target branch
const approveNote = computed(() => props.review?.targetMovedBy
  ? `Approving rebases onto ${target.value} (${props.review.targetMovedBy} commits ahead), runs CI and squash-merges.`
  : `Approving runs CI and squash-merges into ${target.value}.`)

const tabs = computed(() => [
  { label: 'Overview', value: 'overview' },
  ...(total.value ? [{ label: `Tasks ${merged.value}/${total.value}`, value: 'tasks' }] : []),
  ...(props.review?.rounds.length ? [{ label: 'Review', value: 'review' }] : []),
  ...(props.review ? [{ label: 'PR description', value: 'pr' }, { label: `Code diff ${fileCount.value}`, value: 'diff' }] : []),
  { label: 'Message', value: 'message' }
])
const diffPr = computed(() => {
  const pr = props.review?.pr
  const since = props.review?.lastFeedback?.files
  return pr && scope.value === 'since' && since?.length ? { ...pr, files: since } : pr ?? null
})
function showSince() {
  scope.value = 'since'
  tab.value = 'diff'
}
const openTask = (ref: string) => flyout.open(ref)
const tap = (value: string) => props.ctx.act(value as InboxActionInput['action'])
const composing = computed(() => props.ctx.action !== null && actionNeedsText(props.ctx.action))
</script>

<template>
  <div
    class="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    data-testid="inbox-panel-epic-review"
  >
    <div :class="['flex shrink-0 flex-col gap-2 border-b border-default', mobile ? 'p-3' : 'px-5 pt-4 pb-3']">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p class="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted">
            <UIcon
              :name="kind.icon"
              :class="['size-3.5 shrink-0', kind.color]"
            />
            <span class="font-medium text-default">{{ kind.label }}</span>
            <span aria-hidden="true">·</span>
            <span
              class="size-2 shrink-0 rounded-full"
              :style="{ background: item.project.thumbnailColor ?? '#64748b' }"
              aria-hidden="true"
            />
            <span class="truncate">{{ item.project.name }} · {{ item.sender.name }} · {{ timeAgo(item.at) }}</span>
          </p>
          <h1 class="mt-0.5 text-lg leading-tight font-semibold text-highlighted">
            {{ review?.title ?? item.subject }}
          </h1>
        </div>
        <UButton
          v-if="!mobile"
          icon="i-lucide-panel-right"
          aria-label="Epic details"
          title="Epic details"
          variant="ghost"
          color="neutral"
          size="sm"
          @click="flyout.openEpic(item.epicId)"
        />
      </div>
      <p class="line-clamp-2 text-sm">
        <span class="font-medium">TL;DR</span> <span class="text-muted">{{ tldr }}</span>
      </p>
      <div
        v-if="review"
        class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted"
        data-testid="inbox-verdict"
      >
        <span
          v-if="latest"
          class="flex items-center gap-1.5"
        >
          <UIcon
            :name="latest.verdict === 'approved' ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
            :class="['size-4 shrink-0', latest.verdict === 'approved' ? 'text-success' : 'text-warning']"
          />
          <span><span class="font-medium text-default">{{ latest.reviewer }}</span> {{ latest.verdict === 'approved' ? 'approved the epic' : 'requested changes' }}<template v-if="latest.round > 0"> · round {{ latest.round + 1 }}</template></span>
        </span>
        <span
          v-if="review.gateChecks.length"
          class="flex items-center gap-1.5"
        >
          <UIcon
            name="i-lucide-circle-check"
            class="size-4 shrink-0 text-success"
          />
          <span>{{ review.gateChecks.map(g => g.name).join(', ') }} passed</span>
        </span>
        <span class="flex items-center gap-1.5">
          <UIcon
            :name="merged === total ? 'i-lucide-list-checks' : 'i-lucide-list-todo'"
            :class="['size-4 shrink-0', merged === total ? 'text-success' : 'text-warning']"
          />
          <span><span class="font-medium text-default">{{ merged }} of {{ total }}</span> tasks merged</span>
        </span>
        <span
          v-if="canAct"
          class="flex items-center gap-1.5"
        >
          <UIcon
            name="i-lucide-eye"
            class="size-4 shrink-0"
          />
          <span>You saw {{ seen === total ? 'all' : `${seen} of ${total}` }}</span>
        </span>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div
          v-if="canAct && !mobile"
          class="flex flex-wrap items-center gap-2"
        >
          <UButton
            v-for="(a, i) in ctx.actions"
            :key="a.value"
            :label="a.label"
            :icon="a.icon"
            size="sm"
            :color="i === 0 ? 'primary' : 'neutral'"
            :variant="i === 0 ? 'solid' : ctx.action === a.value ? 'subtle' : 'outline'"
            :loading="ctx.busy && ctx.action === a.value"
            :data-testid="i === 0 ? 'inbox-primary' : undefined"
            @click="tap(a.value)"
          />
        </div>
        <p
          v-else-if="!canAct"
          class="min-w-0 text-sm text-muted"
          data-testid="inbox-ask"
        >
          {{ ask }}
        </p>
        <UButton
          :to="item.prUrl"
          target="_blank"
          :label="`Epic PR #${prNumber}`"
          icon="i-lucide-git-pull-request"
          trailing-icon="i-lucide-arrow-up-right"
          color="neutral"
          variant="outline"
          size="sm"
        />
      </div>
      <p
        v-if="canAct"
        class="text-xs text-muted"
      >
        {{ approveNote }}
      </p>
    </div>
    <UTabs
      v-model="tab"
      :items="tabs"
      :content="false"
      variant="link"
      size="sm"
      :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0' }"
      :class="['shrink-0', mobile ? 'px-1' : 'px-3']"
    />
    <div :class="['min-h-0 flex-1 overflow-y-auto overscroll-contain', mobile ? 'p-3' : 'p-5']">
      <div
        v-if="!review && tab !== 'message'"
        class="flex flex-col gap-2"
      >
        <USkeleton class="h-20 w-full" />
        <USkeleton class="h-20 w-full" />
      </div>
      <div
        v-else-if="review && tab === 'overview'"
        class="flex flex-col gap-4"
      >
        <section
          v-if="review.lastFeedback && canAct"
          class="flex flex-col gap-1.5 rounded-md border border-default p-3 text-sm"
          data-testid="epic-since"
        >
          <p class="font-medium text-highlighted">
            Since your last review
          </p>
          <p class="text-muted">
            You asked: {{ review.lastFeedback.text }}
          </p>
          <p class="flex flex-wrap items-center gap-x-2 text-muted">
            <span>Fixed by {{ review.lastFeedback.fixTaskRefs.join(', ') }}</span>
            <UButton
              label="See only these changes"
              variant="link"
              color="primary"
              size="sm"
              class="px-0"
              @click="showSince"
            />
          </p>
        </section>
        <ul
          v-if="notes.length"
          class="flex flex-col gap-1.5 text-sm"
          data-testid="epic-notes"
        >
          <li
            v-for="note in notes"
            :key="note.text"
            class="flex items-start gap-2"
          >
            <UIcon
              name="i-lucide-message-square-warning"
              class="mt-0.5 size-4 shrink-0 text-warning"
            />
            <span>{{ note.text }} <span class="text-muted">{{ note.taskRefs.join(', ') }}</span></span>
          </li>
        </ul>
        <div
          v-if="shots.length"
          :class="['grid gap-2', mobile ? 'grid-cols-2' : 'grid-cols-3']"
        >
          <button
            v-for="s in shots"
            :key="s.evidence.id"
            type="button"
            class="overflow-hidden rounded-md border border-default text-start hover:ring-2 hover:ring-primary"
            @click="viewing = s.evidence"
          >
            <img
              :src="s.evidence.url ?? undefined"
              :alt="s.evidence.fileName ?? ''"
              class="aspect-video w-full object-cover object-top"
            >
            <span class="block truncate px-2 py-1 text-xs text-muted">{{ s.ref }} · {{ s.evidence.fileName }}</span>
          </button>
        </div>
        <p
          v-if="review.conflictTaskRef"
          class="text-sm text-muted"
        >
          Conflict task:
          <button
            type="button"
            class="font-medium text-default hover:underline"
            @click="openTask(review.conflictTaskRef)"
          >
            {{ review.conflictTaskRef }}
          </button>
        </p>
        <p class="text-sm text-muted">
          Review: {{ EPIC_REVIEW_MODE[review.reviewMode].label }} · {{ fileCount }} {{ fileCount === 1 ? 'file' : 'files' }}
          <span class="text-success">+{{ additions }}</span> <span class="text-error">−{{ deletions }}</span> into {{ target }}
        </p>
      </div>
      <ul
        v-else-if="review && tab === 'tasks'"
        class="flex flex-col"
        data-testid="epic-tasks"
      >
        <li
          v-for="t in review.tasks"
          :key="t.ref"
          class="border-b border-default last:border-b-0"
        >
          <button
            type="button"
            class="flex min-h-11 w-full items-center gap-2 py-2 text-start text-sm hover:bg-elevated"
            @click="openTask(t.ref)"
          >
            <UIcon
              :name="t.merged ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'"
              :class="['size-4 shrink-0', t.merged ? 'text-success' : 'text-warning']"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate"><span class="font-mono text-xs text-muted">{{ t.ref }}</span> {{ t.title }}</span>
              <span class="block truncate text-xs text-muted">
                {{ !t.merged ? 'Not merged yet' : t.reviewedBy === 'human' ? 'You reviewed it' : `${latest?.reviewer ?? 'Reviewer'} approved it` }}
                · {{ t.criteriaMet }} of {{ t.criteriaTotal }} criteria
                <template v-if="t.kind !== 'task'"> · {{ t.kind === 'fix' ? 'Fix task' : 'Conflict task' }}</template>
              </span>
            </span>
            <span
              v-if="t.prNumber"
              class="shrink-0 text-xs text-muted"
            >#{{ t.prNumber }}</span>
          </button>
        </li>
      </ul>
      <ol
        v-else-if="review && tab === 'review'"
        class="flex flex-col gap-4"
        data-testid="epic-rounds"
      >
        <li
          v-for="r in review.rounds"
          :key="r.id"
          class="flex flex-col gap-2 text-sm"
        >
          <p class="text-xs text-muted">
            Round {{ r.round + 1 }} · {{ r.verdict === 'approved' ? 'Approved' : 'Changes requested' }} · {{ r.headSha.slice(0, 7) }} · {{ timeAgo(r.createdAt) }}
          </p>
          <ul class="flex flex-col gap-1">
            <li
              v-for="f in r.findings"
              :key="f.text"
              class="flex items-start gap-2"
            >
              <UIcon
                :name="f.level === 'pass' ? 'i-lucide-circle-check' : 'i-lucide-message-square-warning'"
                :class="['mt-0.5 size-4 shrink-0', f.level === 'pass' ? 'text-success' : 'text-warning']"
              />
              <span>{{ f.text }} <span class="text-muted">{{ f.taskRefs.join(', ') }}</span></span>
            </li>
          </ul>
          <MarkdownText :text="r.summary" />
        </li>
      </ol>
      <div
        v-else-if="review && tab === 'pr'"
        class="flex flex-col gap-3"
        data-testid="inbox-pr-description"
      >
        <p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
          <UIcon
            name="i-lucide-git-pull-request"
            class="size-4"
          />
          <span class="font-medium text-default">#{{ review.pr.number }} {{ review.pr.title }}</span>
          <span>{{ review.pr.headBranch }} → {{ review.pr.baseBranch }}</span>
        </p>
        <MarkdownText
          :text="review.pr.body"
          class="text-sm"
        />
      </div>
      <div
        v-else-if="review && tab === 'diff' && diffPr"
        class="flex flex-col gap-3"
      >
        <UTabs
          v-if="review.lastFeedback?.files.length"
          v-model="scope"
          :items="[{ label: 'Whole epic', value: 'all' }, { label: 'Since your last review', value: 'since' }]"
          :content="false"
          size="xs"
          class="self-start"
          data-testid="epic-diff-scope"
        />
        <InboxPanelDiff :pr="diffPr" />
      </div>
      <MarkdownText
        v-else-if="tab === 'message'"
        :text="item.body"
        class="text-sm"
      />
    </div>
    <InboxPanelThumbBar
      v-if="canAct && mobile"
      :ctx="ctx"
      approve-label="Approve epic"
      :reply="false"
    />
    <div
      v-else-if="composing"
      class="shrink-0 border-t border-default p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <InboxPanelTray :ctx="ctx" />
    </div>
    <EvidenceViewer
      :item="viewing"
      @close="viewing = null"
    />
  </div>
</template>
