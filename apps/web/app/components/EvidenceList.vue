<script setup lang="ts">
import type { Evidence, Review, Task } from '@corral/contracts'
import { computed, ref, watch } from 'vue'
import EvidenceGroup from './EvidenceGroup.vue'
import { timeAgo } from '~/utils/labels'

// Criteria next to their evidence (PRD §7.7, design/inbox.md), with the
// reviewer's note per criterion from the latest review
const props = defineProps<{ evidence: Evidence[], criteria: Task['acceptanceCriteria'], reviews: Review[] }>()
const open = ref<Evidence | null>(null)

const latest = computed(() => props.reviews[0] ?? null)
const note = (id: string) => latest.value?.criteria.find(c => c.criterionId === id)?.note ?? ''
const isImage = (e: Evidence) => !!e.contentType?.startsWith('image/')
const isVideo = (e: Evidence) => !!e.contentType?.startsWith('video/')
// Logs, test output and requests: shown as text in the app's theme, not in
// an iframe where the browser picks its own colours
const isText = (e: Evidence) => !!e.contentType && (e.contentType.startsWith('text/') || /json|xml|yaml/.test(e.contentType))
const text = ref<string | null>(null)
const textError = ref<string | null>(null)
watch(open, async (item) => {
  text.value = null
  textError.value = null
  if (!item?.url || !isText(item)) return
  try {
    const res = await fetch(item.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (open.value?.id === item.id) text.value = await res.text()
  } catch (e) {
    if (open.value?.id === item.id) textError.value = `Couldn't load the file: ${e instanceof Error ? e.message : String(e)}`
  }
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      v-for="criterion in props.criteria"
      :key="criterion.id"
      class="rounded-lg border border-default p-3"
    >
      <div class="flex items-start gap-2 text-sm">
        <UIcon
          :name="criterion.met ? 'i-lucide-circle-check' : criterion.met === false ? 'i-lucide-circle-x' : 'i-lucide-circle'"
          :class="['mt-0.5 size-4 shrink-0', criterion.met ? 'text-success' : criterion.met === false ? 'text-error' : 'text-dimmed']"
        />
        <div class="min-w-0 flex-1">
          <MarkdownText
            :text="criterion.text"
            class="font-medium"
          />
          <MarkdownText
            v-if="note(criterion.id)"
            :text="note(criterion.id)"
            class="text-xs text-muted"
          />
        </div>
      </div>
      <EvidenceGroup
        :evidence="props.evidence.filter(e => e.criterionId === criterion.id)"
        @open="open = $event"
      />
    </div>
    <div
      v-if="props.evidence.some(e => e.criterionId === null)"
      class="rounded-lg border border-default p-3"
    >
      <p class="mb-2 text-sm font-medium">
        Task as a whole
      </p>
      <EvidenceGroup
        :evidence="props.evidence.filter(e => e.criterionId === null)"
        @open="open = $event"
      />
    </div>
    <p
      v-if="props.criteria.length === 0 && props.evidence.length === 0"
      class="text-sm text-muted"
    >
      No evidence yet.
    </p>

    <UModal
      :open="open !== null"
      :title="open?.fileName ?? undefined"
      :description="open ? `${open.kind.replace('_', ' ')} · ${timeAgo(open.createdAt)}${open.note ? ` · ${open.note}` : ''}` : ''"
      :ui="{ content: 'max-w-4xl' }"
      @update:open="open = null"
    >
      <template #body>
        <img
          v-if="open && isImage(open)"
          :src="open.url ?? undefined"
          :alt="open.note || open.fileName || undefined"
          class="max-h-[70vh] w-full object-contain"
        >
        <template v-else-if="open && isVideo(open)">
          <video
            :src="open.url ?? undefined"
            controls
            playsinline
            class="max-h-[70vh] w-full"
          />
          <a
            :href="open.url ?? undefined"
            :download="open.fileName ?? ''"
            class="mt-2 inline-block text-sm text-primary hover:underline"
          >Download</a>
        </template>
        <template v-else-if="open && isText(open)">
          <UAlert
            v-if="textError"
            color="error"
            variant="subtle"
            :title="textError"
          />
          <USkeleton
            v-else-if="text === null"
            class="h-40 w-full"
          />
          <pre
            v-else
            class="max-h-[60vh] overflow-auto overscroll-contain rounded-md border border-default bg-muted p-3 font-mono text-xs/5 whitespace-pre-wrap text-default"
          >{{ text }}</pre>
        </template>
        <iframe
          v-else-if="open"
          :src="open.url ?? undefined"
          :title="open.fileName ?? undefined"
          class="h-[60vh] w-full rounded-md border border-default"
        />
      </template>
    </UModal>
  </div>
</template>
