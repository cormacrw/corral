<script setup lang="ts">
import { useInboxEpicActions } from '~/features/inbox/composables/useInboxEpicActions'
import { useInboxEpicReview } from '~/features/inbox/composables/useInboxEpicReview'
import type { EpicInboxItem } from '~/features/inbox/composables/useInboxView'
import InboxEpicDiff from '~/features/inbox/components/InboxEpicDiff.vue'
import InboxEpicVerdict from '~/features/inbox/components/InboxEpicVerdict.vue'
import InboxItemSummary from '~/features/inbox/components/InboxItemSummary.vue'
import InboxPanelActions from '~/features/inbox/components/InboxPanelActions.vue'
import InboxPanelLayout from '~/features/inbox/components/InboxPanelLayout.vue'
import InboxPanelMeta from '~/features/inbox/components/InboxPanelMeta.vue'
import InboxPrDescription from '~/features/inbox/components/InboxPrDescription.vue'

// An epic in the Inbox, Option D (design/inbox.md): what's needed to decide up
// front, then tabs. An epic PR waiting on the human, what stopped an epic, and
// every read-only moment share this layout. On a phone (design/mobile.md) the
// actions and the composer move to the bottom bar.
type Tab = 'overview' | 'tasks' | 'review' | 'pr' | 'diff' | 'message'
// `gone`: the item left the Inbox while open, so the panel stays on what the
// human was reading and nothing can be sent
const props = defineProps<{ item: EpicInboxItem, mobile?: boolean, gone?: boolean }>()
const emit = defineEmits<{ resolved: [] }>()

const r = useInboxEpicReview(props)
const { review, loading, rows, merged, rounds, canAct, feedback } = r
const tab = ref<Tab>('overview')
const { ctx, confirmedCriteria, confirmedTasks, obligations, confirmed } = useInboxEpicActions(props, r, {
  showTasks: () => {
    tab.value = 'tasks'
  },
  resolved: () => emit('resolved')
})

const diffView = ref<'since' | 'whole'>('whole')
function seeChanges() {
  diffView.value = 'since'
  tab.value = 'diff'
}

const prLabel = computed(() => review.value?.pr ? `Task's PR #${review.value.pr.number}` : 'Task\'s PR')
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
const skeleton = computed(() => loading.value && (['pr', 'diff'].includes(openTab.value)
  || (openTab.value === 'overview' && props.item.type !== 'epic_conflict')
  || (openTab.value === 'tasks' && !rows.value.length)
  || (openTab.value === 'review' && !rounds.value.length)))
</script>

<template>
  <InboxPanelLayout
    as="section"
    aria-label="Task review"
    data-testid="inbox-epic-panel"
    :tabs="tabs"
    :open-tab="openTab"
    :mobile="mobile"
    body-class="min-w-0 overflow-x-hidden"
    @select="tab = $event as Tab"
  >
    <template #header>
      <div class="min-w-0">
        <h1 class="text-lg leading-tight font-semibold break-words text-foreground">
          <NuxtLink
            :to="`/epics/${item.epicId}`"
            class="hover:underline"
          >
            {{ item.subject }}
          </NuxtLink>
        </h1>
        <InboxPanelMeta
          class="mt-1"
          :kind="r.kind.value"
          :item="item"
        />
      </div>
      <InboxItemSummary
        :key="item.id"
        :item="item"
      />
      <InboxEpicVerdict
        v-if="item.type === 'epic_review'"
        :item="item"
        :r="r"
      />
      <div
        v-if="!canAct || item.prUrl"
        class="flex flex-wrap items-center justify-between gap-2"
      >
        <p
          v-if="!canAct"
          class="text-sm text-muted-foreground"
          data-testid="inbox-read-only"
        >
          {{ item.resolution ?? 'For your information. Nothing to do.' }}
        </p>
        <AppButton
          v-if="item.prUrl"
          :to="item.prUrl"
          target="_blank"
          :label="prLabel"
          icon="i-hugeicons-git-pull-request"
          trailing-icon="i-hugeicons-arrow-up-right-01"
          color="neutral"
          variant="outline"
          size="sm"
        />
      </div>
      <!-- On a wide screen this sits with the actions at the bottom -->
      <p
        v-if="mobile && canAct && item.type === 'epic_review'"
        class="text-xs text-muted-foreground"
        data-testid="inbox-epic-approving"
      >
        {{ r.approvalNote.value }}
      </p>
    </template>

    <div
      v-if="skeleton"
      class="flex flex-col gap-3"
      data-testid="inbox-epic-loading"
    >
      <UiSkeleton class="h-5 w-72 max-w-full" />
      <UiSkeleton class="h-32 w-full" />
    </div>
    <div
      v-else-if="openTab === 'overview'"
      class="flex min-w-0 flex-col gap-4"
    >
      <AppLoadError
        v-if="r.result.isError.value && !review"
        title="Couldn't load this task's review"
        :description="r.result.error.value?.message"
        :retry="r.refresh"
        data-testid="inbox-epic-error"
      />
      <InboxEpicOverview
        :item="item"
        :review="review"
        :rows="rows"
        :rounds="rounds"
        :feedback="feedback"
        :since-unavailable="r.sinceUnavailable.value"
        :conflict-task="r.conflictTask.value"
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
    <InboxPrDescription
      v-else-if="openTab === 'pr' && review?.pr"
      :pr="review.pr"
    />
    <InboxEpicDiff
      v-else-if="openTab === 'diff' && review?.pr"
      v-model:view="diffView"
      :pr="review.pr"
      :r="r"
    />
    <MarkdownText
      v-else-if="openTab === 'message' || openTab === 'review'"
      :text="item.body"
      class="text-sm break-words"
    />

    <template #footer>
      <InboxPanelThumbBar
        v-if="canAct && mobile"
        :ctx="ctx"
        approve-label="Approve task"
      />
      <div
        v-else-if="canAct"
        class="flex shrink-0 flex-col gap-2 border-t border-border p-3"
      >
        <p
          v-if="item.type === 'epic_review'"
          class="text-xs text-muted-foreground"
          data-testid="inbox-epic-approving"
        >
          {{ r.approvalNote.value }}
        </p>
        <InboxPanelActions
          :ctx="ctx"
          can-act
        />
        <InboxPanelTray
          v-if="ctx.composerChosen"
          :ctx="ctx"
        />
        <AppAlert
          v-else-if="ctx.actionError"
          color="error"
          variant="subtle"
          :title="ctx.actionError"
        />
      </div>
    </template>
  </InboxPanelLayout>
</template>
