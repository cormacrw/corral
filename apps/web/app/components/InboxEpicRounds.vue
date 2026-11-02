<script setup lang="ts">
import type { EpicReviewRound } from '@corral/contracts'
import { timeAgo } from '~/utils/labels'

// The Review tab of an epic in the Inbox (design/inbox.md): for every round,
// the integration findings first, then the reviewer's summary. Newest first.
defineProps<{ rounds: EpicReviewRound[] }>()
</script>

<template>
  <ol
    class="flex min-w-0 flex-col gap-5"
    data-testid="inbox-epic-rounds"
  >
    <li
      v-for="r in rounds"
      :key="r.round"
      class="flex min-w-0 flex-col gap-2 text-sm"
    >
      <p class="flex flex-wrap items-center gap-1.5 text-muted">
        <UIcon
          :name="r.verdict === 'approved' ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
          :class="['size-4 shrink-0', r.verdict === 'approved' ? 'text-success' : 'text-warning']"
        />
        <span><span class="font-medium text-default">{{ r.reviewer.name }}</span> {{ r.verdict === 'approved' ? 'approved' : 'requested changes' }} · round {{ r.round }} · {{ timeAgo(r.at) }}</span>
      </p>
      <ul
        v-if="r.findings.length"
        class="flex min-w-0 flex-col gap-1.5"
        data-testid="inbox-epic-findings"
      >
        <li
          v-for="(finding, i) in r.findings"
          :key="i"
          class="flex min-w-0 items-start gap-2"
        >
          <UBadge
            :label="finding.level === 'blocking' ? 'Blocking' : 'Non-blocking'"
            :color="finding.level === 'blocking' ? 'warning' : 'neutral'"
            variant="subtle"
            size="sm"
            class="shrink-0"
          />
          <span class="min-w-0 break-words"><TaskRefText :text="finding.text" /><template v-if="finding.taskRefs.length"> · <TaskRefText :text="finding.taskRefs.join(', ')" /></template></span>
        </li>
      </ul>
      <MarkdownText
        :text="r.summary"
        class="break-words"
      />
    </li>
  </ol>
</template>
