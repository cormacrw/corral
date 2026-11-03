<script setup lang="ts">
import type { Run, RunEvent } from '@corral/contracts'
import { isLiveRun } from '~/utils/labels'

// A run's timing breakdown and transcript, web and mobile. With a breakdown
// the two scroll together; without one the transcript scrolls itself.
defineProps<{ run: Run, events: RunEvent[], agentName: string, mine?: string[], compact?: boolean }>()
</script>

<template>
  <div :class="run.timings ? ['min-h-0 flex-1 overflow-y-auto overscroll-contain', compact ? 'p-3' : 'p-4'] : 'flex min-h-0 flex-1 flex-col'">
    <div :class="run.timings ? 'mx-auto flex max-w-[880px] flex-col gap-4' : 'flex min-h-0 flex-1 flex-col'">
      <RunTimingBreakdown :run="run" />
      <RunTranscript
        :events="events"
        :inline="!!run.timings"
        :live="isLiveRun(run)"
        :agent-name="agentName"
        :mine="mine"
      />
    </div>
  </div>
</template>
