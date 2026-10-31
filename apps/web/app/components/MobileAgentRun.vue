<script setup lang="ts">
import type { AgentRuns } from '~/composables/useAgentRuns'
import { duration, isLiveRun, runBadge, runRef, runTitle, runTokens } from '~/utils/labels'

// One run's transcript on mobile (design/agent.md, design/mobile.md). It
// fills the screen: its own header with the run and its controls, the
// transcript (streamed over the live connection while the run is live),
// and a footer with the composer while it's live. The layout drops its
// header and tab bar here.
const props = defineProps<{ view: AgentRuns }>()
const { name, agent, pending, events, now, selected, stop, stopping, sent } = props.view
const live = computed(() => !!selected.value && isLiveRun(selected.value))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="shrink-0 border-b border-default pt-(--shell-top) ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]">
      <div class="flex min-h-14 items-center gap-2 px-2 py-1">
        <UButton
          :to="`/agents/${name}`"
          icon="i-lucide-arrow-left"
          variant="ghost"
          color="neutral"
          aria-label="Back"
          class="tap-target"
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs text-muted">
            {{ agent?.name ?? 'Agent' }}<template v-if="selected">
              · Run #{{ selected.number }}
            </template>
          </p>
          <h1 class="truncate font-semibold text-highlighted">
            <template v-if="selected">
              {{ runRef(selected) }} {{ runTitle(selected) }}
            </template>
            <template v-else>
              Run
            </template>
          </h1>
        </div>
        <UButton
          v-if="selected?.taskRef"
          :to="`/tasks/${selected.taskRef}`"
          icon="i-lucide-list-checks"
          variant="ghost"
          color="neutral"
          aria-label="Open task"
          class="tap-target"
        />
      </div>
      <div
        v-if="selected"
        class="flex flex-col gap-2 px-4 pb-3"
      >
        <p class="flex items-center gap-2 text-xs text-muted">
          <UBadge
            :label="runBadge(selected).label"
            :color="runBadge(selected).color"
            variant="subtle"
            size="sm"
          />
          <span class="truncate tabular-nums">{{ duration(selected.startedAt, selected.endedAt, now) }} · {{ runTokens(selected) }}<template v-if="selected.runnerName"> · on {{ selected.runnerName }}</template></span>
        </p>
        <UButton
          v-if="live"
          label="Stop run"
          icon="i-lucide-square"
          color="error"
          variant="subtle"
          block
          :loading="stopping"
          @click="stop(selected)"
        />
      </div>
    </header>

    <!-- Keyed so a run's scroll, steps and draft stay with that run -->
    <div
      v-if="selected && agent"
      :key="selected.id"
      :class="selected.timings ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain p-3' : 'flex min-h-0 flex-1 flex-col'"
    >
      <RunTimingBreakdown
        :run="selected"
        class="mb-4"
      />
      <RunTranscript
        :events="events"
        :inline="!!selected.timings"
        :live="live"
        :agent-name="agent.name"
        :mine="sent[selected.id]"
      />
    </div>
    <p
      v-else-if="agent && !pending"
      class="flex-1 p-4 text-sm text-muted"
    >
      This run isn't in {{ agent.name }}'s recent runs.
    </p>
    <div
      v-else
      class="flex-1 p-4"
    >
      <USkeleton class="h-24 w-full" />
    </div>

    <footer
      v-if="selected && agent"
      class="shrink-0 border-t border-default px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      <RunComposer
        :key="selected.id"
        :view="props.view"
        :run="selected"
      />
    </footer>
  </div>
</template>
