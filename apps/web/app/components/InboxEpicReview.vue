<script setup lang="ts">
import type { EpicReviewItem } from '@corral/contracts'
import { api } from '~/composables/useApi'

const props = defineProps<{ item: EpicReviewItem }>()
const emit = defineEmits<{ resolved: [] }>()
const feedback = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
async function act(action: 'approve' | 'request_changes') {
  busy.value = true
  error.value = null
  try {
    await api.epics.review(props.item.epicId, { action, headSha: props.item.headSha, ...(feedback.value.trim() && { text: feedback.value.trim() }) })
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
    <header class="border-b border-default p-4">
      <UBadge
        label="Epic PR · Needs you"
        color="warning"
        variant="subtle"
      />
      <h1 class="mt-2 text-lg font-semibold">
        {{ item.subject }}
      </h1>
      <p class="text-xs text-muted">
        {{ item.project.name }} · {{ item.sender.name }} approved integration
      </p>
    </header>
    <div class="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
      <MarkdownText :text="item.body" />
      <a
        :href="item.prUrl"
        target="_blank"
        rel="noopener"
        class="text-primary hover:underline"
      >Open epic PR and combined diff</a>
      <article
        v-for="entry in item.tasks"
        :key="entry.task.id"
        class="rounded-lg border border-default p-4"
      >
        <NuxtLink
          :to="`/tasks/${entry.task.ref}`"
          class="font-medium text-primary hover:underline"
        >{{ entry.task.ref }}: {{ entry.task.title }}</NuxtLink>
        <p class="my-2 text-xs text-muted">
          Merged into the epic branch
        </p>
        <EvidenceList
          :evidence="entry.evidence"
          :criteria="entry.task.acceptanceCriteria"
          :reviews="entry.task.latestReview ? [entry.task.latestReview] : []"
        />
      </article>
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
      <div class="flex flex-wrap gap-2">
        <UButton
          label="Approve"
          icon="i-lucide-check"
          :loading="busy"
          @click="act('approve')"
        />
        <UButton
          label="Request changes"
          icon="i-lucide-pencil"
          color="neutral"
          variant="outline"
          :disabled="busy || !feedback.trim()"
          @click="act('request_changes')"
        />
      </div>
    </footer>
  </section>
</template>
