<script setup lang="ts">
import type { EpicReviewItem, EpicReviewTask } from '@corral/contracts'
import { useMutation } from '@tanstack/vue-query'
import { reviewEpic } from '~/queries/epics'
import { holdsInbox } from '~/queries/inbox'

const props = defineProps<{ item: EpicReviewItem }>()
const emit = defineEmits<{ resolved: [] }>()
const device = useDevice()
const feedback = ref('')
const review = useMutation({ ...reviewEpic, ...holdsInbox })
const busy = review.isPending
const unconfirmed = ref(false)
const error = computed(() => unconfirmed.value ? 'Confirm every human check first' : review.error.value?.message ?? null)
// Local to the item, like task human checks: the server wants them on approval
const confirmedCriteria = ref<string[]>([])
const confirmedTasks = ref<string[]>([])
const obligations = computed(() => props.item.tasks.reduce((n, t) => n + t.humanChecks.length + (t.humanReview ? 1 : 0), 0))
const confirmed = computed(() => props.item.tasks.reduce((n, t) => n + t.humanChecks.filter(id => confirmedCriteria.value.includes(id)).length + (t.humanReview && confirmedTasks.value.includes(t.task.id) ? 1 : 0), 0))
watch(() => props.item.id, () => {
  confirmedCriteria.value = []
  confirmedTasks.value = []
})
// Only a task's owed checks are ticked here. Others had their human review on the task.
const taskCriteria = (entry: EpicReviewTask) => entry.task.acceptanceCriteria.map(c => ({ ...c, checkedByHuman: entry.humanChecks.includes(c.id) }))
function act(action: 'approve' | 'request_changes') {
  unconfirmed.value = action === 'approve' && confirmed.value < obligations.value
  if (unconfirmed.value) return
  const input = { action, headSha: props.item.headSha, ...(feedback.value.trim() && { text: feedback.value.trim() }), ...(action === 'approve' && { confirmedCriteria: confirmedCriteria.value, confirmedTasks: confirmedTasks.value }) }
  review.mutate({ id: props.item.epicId, input }, { onSuccess: () => emit('resolved') })
}
</script>

<template>
  <section
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    aria-label="Epic integration review"
  >
    <InboxEpicHeader
      badge="Epic PR · Needs you"
      color="warning"
      :title="item.subject"
      :epic-id="item.epicId"
      :pr-url="item.prUrl"
      pr-label="Open epic PR and combined diff"
    >
      {{ item.project.name }} · {{ item.sender.name }} approved integration
    </InboxEpicHeader>
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
      <InboxMessage
        v-if="item.message"
        :key="item.id"
        :item="item"
        :evidence="item.tasks.flatMap(entry => entry.evidence)"
      />
      <section
        v-else
        aria-label="Integration review"
        class="rounded-lg bg-elevated p-3 break-words"
      >
        <h2 class="mb-1 text-xs font-medium text-muted">
          Integration review
        </h2>
        <MarkdownText :text="item.body" />
      </section>
      <section
        aria-label="Tasks in the epic"
        class="space-y-2"
      >
        <h2 class="text-xs font-medium text-muted">
          {{ item.tasks.length }} {{ item.tasks.length === 1 ? 'task' : 'tasks' }} on the epic branch
        </h2>
        <!-- Closed on a phone, where evidence would push the rest off screen, unless it needs a tick -->
        <details
          v-for="entry in item.tasks"
          :key="entry.task.id"
          :open="!device.isMobile.value || entry.humanReview || entry.humanChecks.length > 0"
          class="group min-w-0 rounded-lg border border-default"
        >
          <summary class="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm">
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 shrink-0 text-muted transition-transform group-open:rotate-90"
            />
            <span class="min-w-0 break-words"><span class="font-mono text-xs text-muted">{{ entry.task.ref }}</span> {{ entry.task.title }}</span>
          </summary>
          <div class="min-w-0 space-y-2 border-t border-default p-3">
            <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <NuxtLink
                :to="`/tasks/${entry.task.ref}`"
                class="text-primary hover:underline"
              >Open task</NuxtLink>
              <TaskCommitLinks :task="entry.task" />
            </p>
            <label
              v-if="entry.humanReview"
              class="flex items-center gap-2 rounded-lg border border-default p-3 text-sm"
            >
              <input
                v-model="confirmedTasks"
                type="checkbox"
                :value="entry.task.id"
              >
              Marked for human review: I reviewed this task
            </label>
            <EvidenceList
              v-model:checked="confirmedCriteria"
              :evidence="entry.evidence"
              :criteria="taskCriteria(entry)"
              :reviews="entry.task.latestReview ? [entry.task.latestReview] : []"
              human-checklist
            />
          </div>
        </details>
      </section>
    </div>
    <footer class="space-y-3 border-t border-default p-4">
      <UAlert
        v-if="error"
        :title="error"
        color="error"
      />
      <p
        v-if="obligations"
        class="text-sm text-muted"
      >
        {{ confirmed }} of {{ obligations }} human {{ obligations === 1 ? 'check' : 'checks' }} confirmed
      </p>
      <UTextarea
        v-model="feedback"
        aria-label="Changes needed"
        placeholder="Describe the changes needed"
        class="w-full"
        :disabled="busy"
      />
      <div class="grid grid-cols-2 gap-2 sm:flex">
        <UButton
          label="Approve"
          icon="i-lucide-check"
          :loading="busy"
          class="justify-center max-sm:min-h-11"
          @click="act('approve')"
        />
        <UButton
          label="Request changes"
          icon="i-lucide-pencil"
          color="neutral"
          variant="outline"
          :disabled="busy || !feedback.trim()"
          class="justify-center max-sm:min-h-11"
          @click="act('request_changes')"
        />
      </div>
    </footer>
  </section>
</template>
