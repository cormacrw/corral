<script setup lang="ts">
import type { AgentRuns } from '~/composables/useAgentRuns'
import { duration, isLiveRun as isLive, runBadge, runRef, runTokens } from '~/utils/labels'

// The transcript of the selected run, inside the agent page. On the web
// that's the run in the URL or the current or latest one; on mobile this
// route only shows with a run in the URL (design/mobile.md).
// One key for every run: the panes key themselves by the selected run, so
// reaching the auto-selected run by URL keeps its draft, and Nuxt only syncs
// the shell's route between runs when this key doesn't change.
definePageMeta({ key: 'agent-run' })

const props = defineProps<{ view: AgentRuns }>()
const { agent, events, now, selected, stop, stopping, sent } = props.view
const flyout = useTaskFlyout()
const device = useDevice()
</script>

<template>
  <MobileAgentRun
    v-if="device.isMobile.value"
    :view="view"
  />
  <div
    v-else
    class="flex min-w-0 flex-1 flex-col"
  >
    <template v-if="selected && agent">
      <!-- One line at the flyout header's height; long titles truncate -->
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4 text-sm">
        <span class="min-w-0 truncate font-medium">{{ runRef(selected) }} {{ selected.taskTitle ?? selected.epicTitle ?? '' }}</span>
        <UBadge
          class="shrink-0"
          :label="runBadge(selected).label"
          :color="runBadge(selected).color"
          variant="subtle"
          size="xs"
        />
        <span class="min-w-0 truncate text-xs text-muted">Run #{{ selected.number }} · {{ duration(selected.startedAt, selected.endedAt, now) }} · {{ runTokens(selected) }}<template v-if="selected.runnerName"> · on <span data-testid="run-runner">{{ selected.runnerName }}</span></template></span>
        <div class="ms-auto flex shrink-0 gap-2">
          <UButton
            v-if="selected.taskRef"
            label="Open task"
            variant="outline"
            color="neutral"
            size="xs"
            @click="flyout.toggle(selected.taskRef)"
          />
          <UButton
            v-if="isLive(selected)"
            label="Stop run"
            color="error"
            variant="subtle"
            size="xs"
            :loading="stopping"
            @click="stop(selected)"
          />
        </div>
      </header>
      <!-- Keyed so a run's scroll, steps and draft stay with that run -->
      <div
        :key="selected.id"
        :class="selected.timings ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain p-4' : 'flex min-h-0 flex-1 flex-col'"
      >
        <div :class="selected.timings ? 'mx-auto flex max-w-[880px] flex-col gap-4' : 'flex min-h-0 flex-1 flex-col'">
          <RunTimingBreakdown :run="selected" />
          <RunTranscript
            :events="events"
            :inline="!!selected.timings"
            :live="isLive(selected)"
            :agent-name="agent.name"
            :mine="sent[selected.id]"
          />
        </div>
      </div>
      <footer class="border-t border-default px-4 py-2">
        <RunComposer
          :key="selected.id"
          :view="view"
          :run="selected"
        />
      </footer>
    </template>
    <div
      v-else-if="agent"
      class="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted"
    >
      <span v-if="agent.role === 'pm'">{{ agent.name }} isn't running. {{ agent.name }} only runs when you send a message in Plan.</span>
      <span v-else>{{ agent.name }} is idle.</span>
    </div>
  </div>
</template>
