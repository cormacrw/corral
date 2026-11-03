<script setup lang="ts">
import type { Epic } from '@corral/contracts'
import { useQuery } from '@tanstack/vue-query'
import { inboxQuery } from '~/queries/inbox'
import { EPIC_REVIEW_MODE, EPIC_REVIEW_STATE } from '~/utils/labels'

// A parent's PR on its flyout and page (design/parent-task.md): the link, its state and
// the review mode. The human's next step is one click, in the Inbox.
const props = defineProps<{ epic: Epic }>()
// Only an item that exists: a review, a stopped parent or a rebase's question
const inbox = useQuery(inboxQuery())
const item = computed(() => inbox.data.value?.needsYou.find(i => i.id === props.epic.id) ?? null)
</script>

<template>
  <div
    v-if="epic.prUrl && epic.reviewMode !== 'direct'"
    class="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3 text-sm"
    data-testid="epic-pr"
  >
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <a
        :href="epic.prUrl"
        target="_blank"
        rel="noopener"
        class="font-medium text-brand hover:underline"
      >Parent PR #{{ epic.prNumber }}</a>
      <AppBadge
        v-if="epic.reviewState"
        :label="EPIC_REVIEW_STATE[epic.reviewState].label"
        :color="EPIC_REVIEW_STATE[epic.reviewState].color"
        variant="subtle"
        size="sm"
      />
    </div>
    <p
      class="text-xs text-muted-foreground"
      :title="EPIC_REVIEW_MODE[epic.reviewMode].description"
    >
      Review mode: {{ EPIC_REVIEW_MODE[epic.reviewMode].label }}
    </p>
    <div v-if="item">
      <AppButton
        :to="`/inbox/${epic.id}`"
        :label="item.type === 'epic_review' ? 'Review in the Inbox' : 'Open in the Inbox'"
        icon="i-ri-inbox-line"
        size="sm"
        class="max-sm:min-h-11"
      />
    </div>
  </div>
</template>
