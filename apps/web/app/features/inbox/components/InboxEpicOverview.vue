<script setup lang="ts">
import type { EpicReview, EpicReviewFeedback, EpicReviewRound, EpicReviewTaskRow, Evidence } from '@corral/contracts'
import type { EpicInboxItem } from '~/features/inbox/composables/useInboxView'
import { EPIC_REVIEW_MODE, plural } from '~/utils/labels'
import { evidenceCriterion } from '~/features/evidence/utils/evidenceFile'
import { currentEvidence } from '~/features/evidence/utils/evidenceRounds'
import InboxEvidenceCarousel from '~/features/inbox/components/InboxEvidenceCarousel.vue'

// The Overview tab of an epic in the Inbox (design/inbox.md): what changed
// since the human last looked, the reviewer's notes, screenshots by task, then
// the review mode and size. What stopped an epic takes the notes' place.
const props = defineProps<{
  item: EpicInboxItem
  review: EpicReview | null
  rows: EpicReviewTaskRow[]
  // Newest first
  rounds: EpicReviewRound[]
  feedback: EpicReviewFeedback | null
  sinceUnavailable: boolean
  // The unfinished task resolving a conflict this item is the record of
  conflictTask: string | null
  mobile?: boolean
}>()
defineEmits<{ seeChanges: [] }>()

const viewing = ref<Evidence | null>(null)
const notes = computed(() => (props.rounds[0]?.findings ?? []).filter(f => f.level === 'non_blocking'))
const screenshots = computed(() => props.rows.flatMap(row => currentEvidence(row.evidence)
  .filter(e => e.url && e.contentType?.startsWith('image/'))
  .map(evidence => ({ evidence, caption: `${row.ref} · ${evidenceCriterion(evidence, row.criteria)}` }))))
const conflict = computed(() => props.item.type === 'epic_conflict' ? props.item : null)
const merged = computed(() => props.rows.filter(r => r.merged).length)
const size = computed(() => [
  plural(props.rows.length, 'task'),
  ...(props.review?.pr ? [plural(props.review.pr.totalFiles, 'file')] : [])
].join(' · '))
// A merged epic names its squash commit; the commit page sits beside the PR
const event = computed(() => props.item.type === 'epic_activity' ? props.item.event : null)
const squash = computed(() => {
  const sha = event.value === 'merged' ? props.review?.mergeCommitSha : null
  const url = props.review?.pr?.url
  return sha ? { sha: sha.slice(0, 7), url: url ? url.replace(/\/pull\/\d+$/, `/commit/${sha}`) : null } : null
})
const next = computed(() => event.value === 'human_approved' && props.review?.state === 'ready_to_merge'
  ? `CI runs next. Once it passes, Corral squash-merges into ${props.review.targetBranch}.`
  : null)
</script>

<template>
  <div
    class="flex min-w-0 flex-col gap-4"
    data-testid="inbox-epic-overview"
  >
    <section
      v-if="feedback"
      class="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3 text-sm"
      data-testid="inbox-epic-since"
    >
      <h2 class="font-medium text-foreground">
        Since your last review
      </h2>
      <blockquote
        v-if="feedback.text"
        class="border-s-2 border-border ps-3 break-words whitespace-pre-wrap text-muted-foreground"
      >
        {{ feedback.text }}
      </blockquote>
      <p
        v-if="feedback.fixTasks.length"
        class="break-words"
      >
        {{ feedback.fixTasks.length === 1 ? 'Fix task' : 'Fix tasks' }}:
        <template
          v-for="(fix, i) in feedback.fixTasks"
          :key="fix.id"
        >
          <template v-if="i">
            ,
          </template><TaskLink :task-ref="fix.ref" /> {{ fix.title }}
        </template>
      </p>
      <div>
        <AppButton
          :label="sinceUnavailable ? 'See only these changes' : `See only these changes (${plural(feedback.totalFiles, 'file')})`"
          variant="link"
          size="sm"
          class="px-0"
          data-testid="inbox-see-changes"
          @click="$emit('seeChanges')"
        />
      </div>
    </section>

    <template v-if="conflict">
      <p
        v-if="conflict.stopped"
        class="text-sm break-words"
      >
        {{ conflict.stopped.error }}
      </p>
      <p
        v-else-if="!conflict.decision"
        class="text-sm break-words"
      >
        The task's PR can't rebase onto {{ conflict.targetBranch }}. Retry goes round the automatic rebase again, and a developer resolves a conflict that remains.
      </p>
      <InboxEpicDecision
        v-if="conflict.decision"
        :item="{ taskId: null, epicId: conflict.epicId, headSha: conflict.headSha, decision: conflict.decision }"
      />
      <section
        v-if="conflict.files.length"
        aria-label="Conflicting files"
        class="min-w-0 rounded-lg border border-border"
      >
        <h2 class="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          {{ plural(conflict.files.length, 'conflicting file') }}
        </h2>
        <ul class="divide-y divide-border">
          <li
            v-for="file in conflict.files"
            :key="file"
            class="flex gap-2 px-3 py-2 font-mono text-sm break-all"
          >
            <Icon
              name="i-hugeicons-file-not-found"
              class="mt-0.5 size-4 shrink-0 text-destructive"
            />
            {{ file }}
          </li>
        </ul>
      </section>
    </template>

    <p
      v-if="conflictTask"
      class="text-sm"
      data-testid="inbox-epic-conflict-task"
    >
      <TaskLink :task-ref="conflictTask" /> is resolving it. {{ merged }} of {{ plural(rows.length, 'task') }} merged.
    </p>
    <p
      v-if="next"
      class="text-sm"
      data-testid="inbox-epic-next"
    >
      {{ next }}
    </p>
    <p
      v-if="squash"
      class="text-sm"
      data-testid="inbox-epic-squash"
    >
      Merged as squash commit
      <a
        v-if="squash.url"
        :href="squash.url"
        target="_blank"
        rel="noopener"
        class="font-mono text-brand hover:underline"
      >{{ squash.sha }}</a>
      <span
        v-else
        class="font-mono"
      >{{ squash.sha }}</span>.
    </p>

    <section
      v-if="notes.length"
      class="flex min-w-0 flex-col gap-1.5 text-sm"
      aria-label="Non-blocking notes"
      data-testid="inbox-epic-notes"
    >
      <h2 class="text-xs font-medium text-muted-foreground">
        Non-blocking {{ notes.length === 1 ? 'note' : 'notes' }}
      </h2>
      <p
        v-for="(note, i) in notes"
        :key="i"
        class="break-words"
      >
        <TaskRefText :text="note.text" />
      </p>
    </section>

    <InboxEvidenceCarousel
      v-if="screenshots.length"
      :shots="screenshots"
      :current="viewing?.id"
      data-testid="inbox-epic-screenshots"
      @open="viewing = $event"
    />

    <p
      v-if="review && item.type !== 'epic_conflict'"
      class="text-xs text-muted-foreground"
      data-testid="inbox-epic-size"
    >
      {{ EPIC_REVIEW_MODE[review.reviewMode].label }} · {{ size }}
    </p>
    <EvidenceViewer
      v-model="viewing"
      :files="screenshots.map(s => s.evidence)"
      :captions="Object.fromEntries(screenshots.map(s => [s.evidence.id, s.caption]))"
    />
  </div>
</template>
