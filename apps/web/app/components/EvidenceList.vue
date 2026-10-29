<script setup lang="ts">
import type { Evidence, Review, Task } from '@corral/contracts'
import { timeAgo } from '~/utils/labels'

// Criteria next to their evidence (PRD §7.7, design/inbox.md), with the
// reviewer's note per criterion from the latest review
const props = defineProps<{ evidence: Evidence[], criteria: Task['acceptanceCriteria'], reviews: Review[] }>()
const open = ref<Evidence | null>(null)

const latest = computed(() => props.reviews[0] ?? null)
// Notes have no file (D21): their text is shown in place
const byCriterion = (id: string | null) => props.evidence.filter(e => e.criterionId === id && e.url !== null)
const notesFor = (id: string | null) => props.evidence.filter(e => e.criterionId === id && e.url === null)
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
      <div
        v-if="byCriterion(criterion.id).length > 0"
        class="mt-2 flex flex-wrap gap-2"
      >
        <button
          v-for="item in byCriterion(criterion.id)"
          :key="item.id"
          type="button"
          class="flex max-w-56 items-center gap-2 rounded-md border border-default p-1.5 text-start text-xs hover:bg-elevated"
          @click="open = item"
        >
          <img
            v-if="isImage(item)"
            :src="item.url ?? undefined"
            :alt="item.note || item.fileName || undefined"
            class="size-12 shrink-0 rounded object-cover"
          >
          <UIcon
            v-else
            :name="isVideo(item) ? 'i-lucide-video' : 'i-lucide-file-text'"
            class="size-6 shrink-0 text-muted"
          />
          <span class="min-w-0">
            <span class="block truncate font-medium">{{ item.fileName }}</span>
            <span class="block truncate text-muted">{{ item.kind.replace('_', ' ') }} · round {{ item.round + 1 }}</span>
          </span>
        </button>
      </div>
      <p
        v-else-if="notesFor(criterion.id).length === 0"
        class="mt-2 text-xs text-dimmed"
      >
        No evidence attached.
      </p>
      <div
        v-for="item in notesFor(criterion.id)"
        :key="item.id"
        class="mt-2 rounded-md border border-default bg-muted p-2 text-xs"
      >
        <p class="mb-1 text-muted">
          Note · round {{ item.round + 1 }}
        </p>
        <MarkdownText :text="item.note" />
      </div>
    </div>
    <div
      v-if="byCriterion(null).length > 0 || notesFor(null).length > 0"
      class="rounded-lg border border-default p-3"
    >
      <p class="mb-2 text-sm font-medium">
        Task as a whole
      </p>
      <div
        v-for="item in notesFor(null)"
        :key="item.id"
        class="mb-2 rounded-md border border-default bg-muted p-2 text-xs"
      >
        <MarkdownText :text="item.note" />
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="item in byCriterion(null)"
          :key="item.id"
          type="button"
          class="flex items-center gap-2 rounded-md border border-default p-1.5 text-xs hover:bg-elevated"
          @click="open = item"
        >
          <UIcon
            name="i-lucide-file-text"
            class="size-5 text-muted"
          />
          {{ item.fileName }}
        </button>
      </div>
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
        <video
          v-else-if="open && isVideo(open)"
          :src="open.url ?? undefined"
          controls
          class="max-h-[70vh] w-full"
        />
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
