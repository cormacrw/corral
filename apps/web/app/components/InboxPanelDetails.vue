<script setup lang="ts">
import type { InboxPanel, InboxPanelContext } from '~/composables/useInboxPanel'
import { timeAgo } from '~/utils/labels'

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
      <UIcon
        :name="r.verdict === 'approved' ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
        :class="['mt-0.5 size-4 shrink-0', r.verdict === 'approved' ? 'text-success' : 'text-warning']"
      />
      <div class="min-w-0 flex-1">
        <p class="text-xs text-muted">
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
    <USkeleton class="h-5 w-72" />
    <USkeleton class="h-40 w-full" />
  </div>
  <UAlert
    v-else-if="(section === 'pr' || section === 'diff') && p.prFailed.value"
    color="error"
    variant="subtle"
    title="Couldn't load this pull request"
    :description="p.prError.value ?? undefined"
    :actions="[{ label: 'Retry', onClick: p.retryPullRequest }]"
    data-testid="inbox-pr-error"
  />
  <div
    v-else-if="section === 'pr' && p.prDetail.value"
    class="flex flex-col gap-3"
    data-testid="inbox-pr-description"
  >
    <div class="text-sm text-muted">
      <p class="flex items-center gap-2 font-medium text-default">
        <UIcon
          name="i-lucide-git-pull-request"
          class="size-4 shrink-0 text-muted"
        />
        <span class="min-w-0">#{{ p.prDetail.value.number }} {{ p.prDetail.value.title }}</span>
      </p>
      <p class="truncate">
        {{ p.prDetail.value.headBranch }} → {{ p.prDetail.value.baseBranch }}
      </p>
    </div>
    <MarkdownText
      v-if="p.prDetail.value.body"
      :text="p.prDetail.value.body"
      class="text-sm"
    />
    <p
      v-else
      class="text-sm text-muted"
    >
      This PR has no description.
    </p>
  </div>
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
