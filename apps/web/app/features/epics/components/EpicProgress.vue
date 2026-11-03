<script setup lang="ts">
import { TONE_TEXT } from '~/lib/tone'
import type { EpicDetail } from '@corral/contracts'
import { isTaskDone } from '@corral/core'
import { epicReviewStatus, epicWithLiveCounts, statusCounts } from '~/utils/labels'

// How far an epic has come, and what its review is waiting on
const props = defineProps<{ epic: EpicDetail }>()
// Progress counts tasks on the board or in the Backlog; Drafts aren't yet
const placed = computed(() => props.epic.tasks.filter(t => t.status !== 'draft'))
const merged = computed(() => placed.value.filter(isTaskDone).length)
const drafts = computed(() => props.epic.tasks.length - placed.value.length)
const byStatus = computed(() => statusCounts(props.epic.tasks))
const reviewStatus = computed(() => epicReviewStatus(epicWithLiveCounts(props.epic, props.epic.tasks)))
// The PR block says this itself, unless the branch's state needs saying too
const inPrBlock = computed(() => props.epic.prUrl && props.epic.reviewMode !== 'direct' && !props.epic.sync)
</script>

<template>
  <section>
    <div class="mb-1 flex items-center justify-between text-xs text-muted-foreground">
      <span class="font-medium">Progress</span>
      <span>{{ merged }} of {{ placed.length }} done<span v-if="drafts"> · {{ drafts }} draft{{ drafts === 1 ? '' : 's' }}</span></span>
    </div>
    <div
      role="progressbar"
      :aria-label="`${merged} of ${placed.length} tasks done`"
      :aria-valuenow="merged"
      aria-valuemin="0"
      :aria-valuemax="placed.length"
      class="flex h-1.5 overflow-hidden rounded-full bg-input"
    >
      <span
        class="bg-success"
        :style="{ width: placed.length ? `${(merged / placed.length) * 100}%` : '0' }"
      />
    </div>
    <div class="mt-2 flex flex-wrap gap-1">
      <StatusBadge
        v-for="s in byStatus"
        :key="s.label"
        :status="s.status"
        :label="`${s.label} ${s.count}`"
        size="xs"
      />
    </div>
    <p
      v-if="reviewStatus && !inPrBlock"
      :class="['mt-2 text-sm font-medium', TONE_TEXT[reviewStatus.color]]"
    >
      {{ reviewStatus.label }}
    </p>
  </section>
</template>
