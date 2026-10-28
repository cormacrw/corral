<script setup lang="ts">
import type { Evidence, Review, Task } from '@corral/contracts'
import { timeAgo } from '~/utils/labels'

// Criteria next to their evidence (PRD §7.7, design/inbox.md), with the
// reviewer's note per criterion from the latest review
const props = defineProps<{ evidence: Evidence[], criteria: Task['acceptanceCriteria'], reviews: Review[] }>()
const open = ref<Evidence | null>(null)

const latest = computed(() => props.reviews[0] ?? null)
const byCriterion = (id: string | null) => props.evidence.filter(e => e.criterionId === id)
const note = (id: string) => latest.value?.criteria.find(c => c.criterionId === id)?.note ?? ''
const isImage = (e: Evidence) => e.contentType.startsWith('image/')
const isVideo = (e: Evidence) => e.contentType.startsWith('video/')
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
          <p class="font-medium">
            {{ criterion.text }}
          </p>
          <p
            v-if="note(criterion.id)"
            class="text-xs text-muted"
          >
            {{ note(criterion.id) }}
          </p>
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
            :src="item.url"
            :alt="item.note || item.fileName"
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
        v-else
        class="mt-2 text-xs text-dimmed"
      >
        No evidence attached.
      </p>
    </div>
    <div
      v-if="byCriterion(null).length > 0"
      class="rounded-lg border border-default p-3"
    >
      <p class="mb-2 text-sm font-medium">
        Task as a whole
      </p>
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
      :title="open?.fileName"
      :description="open ? `${open.kind.replace('_', ' ')} · ${timeAgo(open.createdAt)}${open.note ? ` · ${open.note}` : ''}` : ''"
      :ui="{ content: 'max-w-4xl' }"
      @update:open="open = null"
    >
      <template #body>
        <img
          v-if="open && isImage(open)"
          :src="open.url"
          :alt="open.note || open.fileName"
          class="max-h-[70vh] w-full object-contain"
        >
        <video
          v-else-if="open && isVideo(open)"
          :src="open.url"
          controls
          class="max-h-[70vh] w-full"
        />
        <iframe
          v-else-if="open"
          :src="open.url"
          :title="open.fileName"
          class="h-[60vh] w-full rounded-md border border-default bg-white"
        />
      </template>
    </UModal>
  </div>
</template>
