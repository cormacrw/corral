<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { EpicReviewItem } from '@corral/contracts'
import { reviewEpic } from '~/queries/epics'

const props = defineProps<{ item: EpicReviewItem }>()
const emit = defineEmits<{ resolved: [] }>()
const device = useDevice()
const feedback = ref('')
const review = useMutation(reviewEpic)
const busy = ref(false)
const error = ref<string | null>(null)
async function act(action: 'approve' | 'request_changes') {
  busy.value = true
  error.value = null
  try {
    await review.mutateAsync({ id: props.item.epicId, input: { action, headSha: props.item.headSha, ...(feedback.value.trim() && { text: feedback.value.trim() }) } })
    emit('resolved')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
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
          {{ item.tasks.length }} {{ item.tasks.length === 1 ? 'task' : 'tasks' }} merged into the epic branch
        </h2>
        <!-- Closed on a phone, where evidence would push the rest off screen -->
        <details
          v-for="entry in item.tasks"
          :key="entry.task.id"
          :open="!device.isMobile.value"
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
            <NuxtLink
              :to="`/tasks/${entry.task.ref}`"
              class="text-sm text-primary hover:underline"
            >Open task</NuxtLink>
            <EvidenceList
              :evidence="entry.evidence"
              :criteria="entry.task.acceptanceCriteria"
              :reviews="entry.task.latestReview ? [entry.task.latestReview] : []"
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
