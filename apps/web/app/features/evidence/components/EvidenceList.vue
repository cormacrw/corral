<script setup lang="ts">
import type { Evidence, Review, Task } from '@corral/contracts'
import { computed, ref } from 'vue'
import CriterionMetIcon from '~/features/evidence/components/CriterionMetIcon.vue'
import EvidenceGroup from '~/features/evidence/components/EvidenceGroup.vue'
import EvidenceViewer from '~/features/evidence/components/EvidenceViewer.vue'
import { evidenceCriterion } from '~/features/evidence/utils/evidenceFile'
import type { ViewerFile } from '~/features/evidence/components/EvidenceViewer.vue'

// Criteria next to their evidence (PRD §7.7, design/inbox.md), with the
// reviewer's note per criterion from the latest review
const props = defineProps<{ evidence: Evidence[], criteria: Task['acceptanceCriteria'], reviews: Review[], humanChecklist?: boolean }>()
const checked = defineModel<string[]>('checked', { default: () => [] })
const open = ref<ViewerFile | null>(null)

const latest = computed(() => props.reviews[0] ?? null)
const forTask = computed(() => props.evidence.filter(e => e.criterionId === null))
// The viewer flips through the files in the order they're listed
const files = computed(() => [...props.criteria.flatMap(c => props.evidence.filter(e => e.criterionId === c.id)), ...forTask.value].filter(e => e.url))
const note = (id: string) => latest.value?.criteria.find(c => c.criterionId === id)?.note ?? ''
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      v-for="criterion in props.criteria"
      :key="criterion.id"
      class="rounded-lg border border-border p-3"
    >
      <div class="flex items-start gap-2 text-sm">
        <CriterionMetIcon
          :met="criterion.met"
          class="mt-0.5"
        />
        <div class="min-w-0 flex-1">
          <MarkdownText
            :text="criterion.text"
            class="font-medium"
          />
          <p
            v-if="criterion.checkedByHuman"
            class="text-xs text-muted-foreground"
          >
            Needs human check
          </p>
          <label
            v-if="humanChecklist && criterion.checkedByHuman"
            class="mt-2 flex items-center gap-2"
          >
            <input
              v-model="checked"
              type="checkbox"
              :value="criterion.id"
            >
            I checked this criterion
          </label>
          <MarkdownText
            v-if="!criterion.checkedByHuman && note(criterion.id)"
            :text="note(criterion.id)"
            class="text-xs text-muted-foreground"
          />
        </div>
      </div>
      <EvidenceGroup
        :evidence="props.evidence.filter(e => e.criterionId === criterion.id)"
        @open="open = $event"
      />
    </div>
    <div
      v-if="forTask.length > 0"
      class="rounded-lg border border-border p-3"
    >
      <p class="mb-2 text-sm font-medium">
        Task as a whole
      </p>
      <EvidenceGroup
        :evidence="forTask"
        @open="open = $event"
      />
    </div>
    <p
      v-if="props.criteria.length === 0 && props.evidence.length === 0"
      class="text-sm text-muted-foreground"
    >
      No evidence yet.
    </p>

    <EvidenceViewer
      v-model="open"
      :files="files"
      :captions="Object.fromEntries(props.evidence.map(e => [e.id, evidenceCriterion(e, props.criteria)]))"
    />
  </div>
</template>
