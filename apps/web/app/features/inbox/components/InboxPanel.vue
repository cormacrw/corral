<script setup lang="ts">
import { useInboxPanel, type InboxPanelContext, type InboxPanelTab } from '~/features/inbox/composables/useInboxPanel'
import InboxItemSummary from '~/features/inbox/components/InboxItemSummary.vue'
import InboxPanelLayout from '~/features/inbox/components/InboxPanelLayout.vue'
import InboxPanelOverview from '~/features/inbox/components/InboxPanelOverview.vue'

// The Inbox message panel, Option D (design/inbox.md): what's needed to decide
// up front, then tabs for everything else. On a phone (design/mobile.md) the
// actions and the composer move to the bottom bar.
const props = defineProps<{ ctx: InboxPanelContext, mobile?: boolean }>()
const p = useInboxPanel(props.ctx)
const tray = ref<{ send: () => Promise<boolean> } | null>(null)
// A one-click action sends through the composer when it's open, for its
// images. Closed, the action goes alone: no hidden draft goes with it.
defineExpose({ send: () => tray.value?.send() ?? props.ctx.submit('') })

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
// A tab's content can load after the page asks for it, or go away
const openTab = computed(() => tabs.value.some(t => t.value === props.ctx.tab) ? props.ctx.tab : 'overview')
const details = computed(() => openTab.value as Exclude<InboxPanelTab, 'overview'>)
</script>

<template>
  <InboxPanelLayout
    data-testid="inbox-panel-option-d"
    :tabs="tabs"
    :open-tab="openTab"
    :mobile="mobile"
    @select="ctx.setTab($event as InboxPanelTab)"
  >
    <template #header>
      <div class="min-w-0">
        <h1 class="text-lg leading-tight font-semibold text-foreground">
          {{ ctx.item.subject }}
        </h1>
        <InboxPanelMeta
          class="mt-1"
          :kind="p.kind.value"
          :item="ctx.item"
        />
      </div>
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
    />

    <template #footer>
      <InboxPanelThumbBar
        v-if="p.canAct.value && mobile"
        ref="tray"
        :ctx="ctx"
      />
      <div
        v-else-if="p.canAct.value"
        class="flex shrink-0 flex-col gap-2 border-t border-border p-3"
      >
        <InboxPanelActions
          :ctx="ctx"
          can-act
        />
        <!-- The composer is for actions: it opens with one that takes words,
             and a failed item opens on its Retry note -->
        <InboxPanelTray
          v-if="ctx.composerChosen || ctx.item.type === 'failed'"
          ref="tray"
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
