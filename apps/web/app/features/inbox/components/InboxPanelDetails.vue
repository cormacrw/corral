<script setup lang="ts">
import type { InboxPanel, InboxPanelContext } from '~/features/inbox/composables/useInboxPanel'
import { verdictMark } from '~/features/inbox/utils/inbox-summary'
import { timeAgo } from '~/utils/labels'
import InboxPrDescription from '~/features/inbox/components/InboxPrDescription.vue'

// What the panel keeps a click away, one tab at a time: the criteria with their
// notes and evidence, the review history, the PR and the full message
const props = defineProps<{ ctx: InboxPanelContext, p: InboxPanel, section: 'criteria' | 'review' | 'pr' | 'diff' | 'message' }>()
const reviews = computed(() => props.p.history.value)
</script>

<template>
  <EvidenceList
    v-if="section === 'criteria'"
    :checked="ctx.checkedHumanCriteria"
    :evidence="ctx.evidence"
    :human-checklist="p.canAct.value"
    :criteria="p.criteria.value"
    :reviews="reviews"
    @update:checked="ctx.setCheckedHumanCriteria"
  />
  <ol
    v-else-if="section === 'review'"
    class="flex flex-col gap-3"
  >
    <li
      v-for="r in reviews"
      :key="r.id"
      class="flex gap-2 text-sm"
    >
      <Icon
        :name="verdictMark(r.verdict === 'approved').icon"
        :class="['mt-0.5 size-4 shrink-0', verdictMark(r.verdict === 'approved').color]"
      />
      <div class="min-w-0 flex-1">
        <p class="text-xs text-muted-foreground">
          Round {{ r.round + 1 }} · {{ r.verdict === 'approved' ? 'Approved' : 'Changes requested' }} · {{ r.headSha.slice(0, 7) }} · {{ timeAgo(r.createdAt) }}
        </p>
        <MarkdownText :text="r.summary" />
      </div>
    </li>
  </ol>
  <div
    v-else-if="(section === 'pr' || section === 'diff') && p.prLoading.value"
    class="flex flex-col gap-3"
    data-testid="inbox-pr-loading"
  >
    <UiSkeleton class="h-5 w-72" />
    <UiSkeleton class="h-40 w-full" />
  </div>
  <AppLoadError
    v-else-if="(section === 'pr' || section === 'diff') && p.prFailed.value"
    title="Couldn't load this pull request"
    :description="p.prError.value ?? undefined"
    :retry="p.retryPullRequest"
    data-testid="inbox-pr-error"
  />
  <InboxPrDescription
    v-else-if="section === 'pr' && p.prDetail.value"
    :pr="p.prDetail.value"
    icon
  />
  <InboxPanelDiff
    v-else-if="section === 'diff' && p.prDetail.value"
    :pr="p.prDetail.value"
  />
  <MarkdownText
    v-else
    :text="ctx.item.body"
    class="text-sm"
  />
</template>
