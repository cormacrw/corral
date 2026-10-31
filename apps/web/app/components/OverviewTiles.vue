<script setup lang="ts">
import type { ProjectOverview } from '~/composables/useProjectOverview'
import { STATUS, STATUS_DOT } from '~/utils/labels'

// The project overview's stat tiles (design/project-overview.md): a grid on the
// web, a row that scrolls sideways on a phone
const props = defineProps<{ overview: ProjectOverview, mobile?: boolean }>()
// Keeps a loading tile's height
const BLANK = String.fromCharCode(160)
const { loading, count, needsYou, mergedThisWeek, firstPass, waitingOnDependency, developer, reviewer } = props.overview
const tiles = computed(() => [
  { label: 'Ready', color: STATUS.ready.color, value: count('ready'), sub: waitingOnDependency.value ? `${waitingOnDependency.value} waiting on a dependency` : 'scheduled next' },
  { label: 'In progress', color: STATUS.in_progress.color, value: count('in_progress'), sub: developer.value ? `${developer.value} working` : 'no run active' },
  { label: 'Agent review', color: STATUS.agent_review.color, value: count('agent_review'), sub: reviewer.value ? `${reviewer.value} reviewing` : 'waiting' },
  { label: 'Needs you', color: STATUS.human_review.color, value: needsYou.value.length, sub: `${count('human_review')} review · ${count('blocked')} blocked · ${count('failed')} failed` },
  { label: 'Completed this week', color: STATUS.merged.color, value: mergedThisWeek.value.length, sub: firstPass.value === null ? 'no merges yet' : `first-pass approval ${firstPass.value}%` }
])
</script>

<template>
  <!-- Stat tiles scroll sideways on a phone rather than wrap -->
  <div :class="mobile ? 'flex snap-x scroll-px-4 gap-2 overflow-x-auto overscroll-x-contain px-4' : 'grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3'">
    <dl
      v-for="tile in tiles"
      :key="tile.label"
      :class="['rounded-lg border border-default p-3', mobile && 'w-40 shrink-0 snap-start']"
    >
      <dt class="flex items-center gap-1.5 truncate text-xs text-muted">
        <span
          :class="['size-2 shrink-0 rounded-full', STATUS_DOT[tile.color]]"
          aria-hidden="true"
        />{{ tile.label }}
      </dt>
      <dd class="text-2xl font-semibold tabular-nums">
        <USkeleton
          v-if="loading"
          class="my-1 h-6 w-8"
        />
        <template v-else>
          {{ tile.value }}
        </template>
      </dd>
      <dd :class="['text-xs text-muted', !mobile && 'truncate']">
        {{ loading ? BLANK : tile.sub }}
      </dd>
    </dl>
  </div>
</template>
