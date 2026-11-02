<script setup lang="ts">
import type { EpicReviewTaskRow } from '@corral/contracts'
import { plural } from '~/utils/labels'

// The Tasks tab of an epic in the Inbox (design/inbox.md): one row per task,
// opening it. A task with human checks still owed has them ticked here.
const props = defineProps<{ rows: EpicReviewTaskRow[], canTick: boolean, obligations: number, confirmed: number }>()
const confirmedCriteria = defineModel<string[]>('confirmedCriteria', { required: true })
const confirmedTasks = defineModel<string[]>('confirmedTasks', { required: true })

const passedBy = (row: EpicReviewTaskRow) => row.reviewedBy === 'human' ? 'You passed it' : row.reviewedBy === 'reviewer' ? 'Reviewer passed it' : 'Not passed yet'
const KIND = { fix: 'Fix task', conflict: 'Conflict task' } as const
const kindLabel = (row: EpicReviewTaskRow) => row.kind === 'normal' ? null : KIND[row.kind]
const shortSha = (sha: string) => sha.slice(0, 7)
// Only what's owed is ticked here. Other checks were settled on the task.
const owedCriteria = (row: EpicReviewTaskRow) => row.criteria.filter(c => row.humanChecks.includes(c.id)).map(c => ({ ...c, checkedByHuman: true }))
const owes = (row: EpicReviewTaskRow) => props.canTick && (row.humanReview || row.humanChecks.length > 0)
</script>

<template>
  <div
    class="flex min-w-0 flex-col gap-2"
    data-testid="inbox-epic-tasks"
  >
    <p
      v-if="canTick && obligations"
      class="text-sm text-muted"
      data-testid="inbox-epic-checks-left"
    >
      {{ confirmed }} of {{ plural(obligations, 'human check') }} confirmed
    </p>
    <article
      v-for="row in rows"
      :key="row.id"
      class="min-w-0 rounded-lg border border-default"
      data-testid="inbox-epic-task"
    >
      <NuxtLink
        :to="`/tasks/${row.ref}`"
        class="block min-w-0 px-3 py-2 text-sm hover:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span class="break-words"><span class="font-mono text-xs text-muted">{{ row.ref }}</span> {{ row.title }}</span>
      </NuxtLink>
      <p class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 text-xs text-muted">
        <span>{{ passedBy(row) }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ row.criteriaMet }} of {{ row.criteriaTotal }} {{ row.criteriaTotal === 1 ? 'criterion' : 'criteria' }} met</span>
        <template v-if="row.prNumber && row.prUrl">
          <span aria-hidden="true">·</span>
          <a
            :href="row.prUrl"
            target="_blank"
            rel="noopener"
            class="text-primary hover:underline"
          >PR #{{ row.prNumber }}</a>
        </template>
        <template v-else-if="row.integratedCommit">
          <span aria-hidden="true">·</span>
          <a
            :href="row.integratedCommit.url ?? undefined"
            target="_blank"
            rel="noopener"
            class="font-mono text-primary hover:underline"
          >{{ shortSha(row.integratedCommit.sha) }}</a>
        </template>
        <UBadge
          v-if="kindLabel(row)"
          :label="kindLabel(row)!"
          color="neutral"
          variant="subtle"
          size="sm"
        />
      </p>
      <div
        v-if="owes(row)"
        class="min-w-0 space-y-2 border-t border-default p-3"
      >
        <label
          v-if="row.humanReview"
          class="flex items-center gap-2 text-sm"
        >
          <input
            v-model="confirmedTasks"
            type="checkbox"
            :value="row.id"
          >
          Marked for human review: I reviewed this task
        </label>
        <EvidenceList
          v-if="row.humanChecks.length"
          v-model:checked="confirmedCriteria"
          :evidence="row.evidence"
          :criteria="owedCriteria(row)"
          :reviews="[]"
          human-checklist
        />
      </div>
    </article>
  </div>
</template>
