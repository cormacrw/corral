<script setup lang="ts">
import type { AgentRuns } from '~/composables/useAgentRuns'
import { duration, isLiveRun, runBadge, timeAgo, tokens } from '~/utils/labels'

// One run's transcript on mobile (design/agent.md, design/mobile.md). It
// fills the screen: its own header with the run and its controls, the
// transcript (streamed over the live connection while the run is live),
// and a footer. The layout drops its header and tab bar here.
const props = defineProps<{ view: AgentRuns }>()
const { name, agent, runs, events, now, selected, stop } = props.view
const live = computed(() => !!selected.value && isLiveRun(selected.value))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="shrink-0 border-b border-default pt-[env(safe-area-inset-top)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]">
      <div class="flex min-h-14 items-center gap-2 px-2 py-1">
        <UButton
          :to="`/agents/${name}`"
          icon="i-lucide-arrow-left"
          variant="ghost"
          color="neutral"
          aria-label="Back"
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs text-muted">
            {{ agent?.name ?? 'Agent' }}<template v-if="selected">
              · Run #{{ selected.number }}
            </template>
          </p>
          <h1 class="truncate font-semibold text-highlighted">
            <template v-if="selected">
              {{ selected.taskRef ?? 'Plan' }} {{ selected.taskTitle ?? selected.summary ?? 'PM turn' }}
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
          <span class="truncate tabular-nums">{{ duration(selected.startedAt, selected.endedAt, now) }} · {{ tokens((selected.inputTokens ?? 0) + (selected.outputTokens ?? 0)) }} tokens</span>
        </p>
        <UButton
          v-if="live"
          label="Stop run"
          icon="i-lucide-square"
          color="error"
          variant="subtle"
          block
          @click="stop(selected)"
        />
      </div>
    </header>

    <RunTranscript
      v-if="selected && agent"
      :events="events"
      :live="live"
      :agent-name="agent.name"
    />
    <p
      v-else-if="agent && runs.length > 0"
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
      class="shrink-0 border-t border-default px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-xs text-muted"
    >
      <span v-if="live">Live. Mid-run messages aren't supported yet; comment on the task and {{ agent.name }} reads it on its next run.</span>
      <span v-else><UIcon
        name="i-lucide-lock"
        class="size-3"
      /> Read-only. This run finished {{ timeAgo(selected.endedAt, now) }}. To change the work, comment on the task.</span>
    </footer>
  </div>
</template>
