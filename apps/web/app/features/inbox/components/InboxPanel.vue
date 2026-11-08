<script setup lang="ts">
import { shownTab, useInboxPanel, type InboxPanelContext, type InboxPanelTab } from '~/features/inbox/composables/useInboxPanel'
import InboxItemSummary from '~/features/inbox/components/InboxItemSummary.vue'
import InboxPanelLayout from '~/features/inbox/components/InboxPanelLayout.vue'
import InboxPanelOverview from '~/features/inbox/components/InboxPanelOverview.vue'

// The Inbox message panel, Option D (design/inbox.md): what's needed to decide
// up front, then tabs for everything else. On a phone (design/mobile.md) the
// actions and the composer move to the bottom bar.
const props = defineProps<{ ctx: InboxPanelContext, mobile?: boolean }>()
const p = useInboxPanel(props.ctx)
const footer = ref<{ send: () => Promise<boolean> | null } | null>(null)
// A one-click action sends through the composer when it's open, for its
// images. Closed, the action goes alone: no hidden draft goes with it.
defineExpose({ send: () => footer.value?.send() ?? props.ctx.submit('') })

const tabs = computed(() => [
  { label: 'Overview', value: 'overview' },
  ...(p.criteria.value.length ? [{ label: `Criteria ${p.met.value}/${p.criteria.value.length}`, value: 'criteria' }] : []),
  ...(p.history.value.length ? [{ label: 'Review', value: 'review' }] : []),
  // Before the PR arrives, or if it can't, the tabs stay to say so
  ...(p.hasPullRequest.value
    ? [
        { label: 'PR description', value: 'pr' },
        { label: p.prDetail.value ? `Code diff ${p.prDetail.value.totalFiles}` : 'Code diff', value: 'diff' }
      ]
    : []),
  { label: 'Message', value: 'message' }
])
const openTab = computed(() => shownTab(tabs.value, props.ctx.tab))
const details = computed(() => openTab.value as Exclude<InboxPanelTab, 'overview'>)
</script>

<template>
  <InboxPanelLayout
    data-testid="inbox-panel-option-d"
    :item="ctx.item"
    :kind="p.kind.value"
    :tabs="tabs"
    :open-tab="openTab"
    :mobile="mobile"
    @select="ctx.setTab($event as InboxPanelTab)"
  >
    <template #header>
      <InboxItemSummary :item="ctx.item" />
      <InboxPanelEpicContext
        v-if="p.isReview.value"
        :task="ctx.task"
        :pr-number="p.pr.value?.number ?? null"
        :can-act="p.canAct.value"
      />
      <UiSkeleton
        v-if="ctx.taskLoading && p.isReview.value"
        class="h-5 w-72"
        data-testid="inbox-verdict-loading"
      />
      <InboxPanelVerdict
        v-else
        :p="p"
      />
      <InboxPanelArtifacts
        :ctx="ctx"
        :p="p"
        :mobile="mobile"
      />
      <AppLoadError
        v-if="ctx.taskLoadFailed"
        title="Couldn't load this task"
        :retry="ctx.retryTask"
      />
    </template>

    <InboxPanelOverview
      v-if="openTab === 'overview'"
      :ctx="ctx"
      :p="p"
      :mobile="mobile"
    />
    <InboxPanelDetails
      v-else
      :ctx="ctx"
      :p="p"
      :section="details"
      :mobile="mobile"
    />

    <template #footer>
      <!-- The composer is for actions: it opens with one that takes words,
           and a failed item opens on its Retry note -->
      <InboxPanelFooter
        v-if="p.canAct.value"
        ref="footer"
        :ctx="ctx"
        :mobile="mobile"
        :composer="ctx.composerChosen || ctx.item.type === 'failed'"
      />
    </template>
  </InboxPanelLayout>
</template>
