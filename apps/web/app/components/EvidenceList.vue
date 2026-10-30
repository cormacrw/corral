<script setup lang="ts">
import type { Evidence, Review, Task } from '@corral/contracts'
import { computed, ref } from 'vue'
import EvidenceGroup from './EvidenceGroup.vue'
import EvidenceViewer from './EvidenceViewer.vue'

// Criteria next to their evidence (PRD §7.7, design/inbox.md), with the
// reviewer's note per criterion from the latest review
const props = defineProps<{ evidence: Evidence[], criteria: Task['acceptanceCriteria'], reviews: Review[] }>()
const open = ref<Evidence | null>(null)

const latest = computed(() => props.reviews[0] ?? null)
const note = (id: string) => latest.value?.criteria.find(c => c.criterionId === id)?.note ?? ''
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

    <EvidenceViewer
      :item="open"
      @close="open = null"
    />
  </div>
</template>
