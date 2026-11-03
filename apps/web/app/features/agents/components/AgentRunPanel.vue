<script setup lang="ts">
import type { AgentRuns } from '~/features/runs/composables/useAgentRuns'
import { agentIdleNote } from '~/features/agents/utils/agents'
import { duration, isLiveRun as isLive, runBadge, runRef, runTokens } from '~/utils/labels'

// The selected run on the web, beside the runs list (design/agent.md): the run
// in the URL or the current or latest one.
const props = defineProps<{ view: AgentRuns }>()
const { agent, events, now, selected, stop, stopping, sent } = props.view
const flyout = useTaskFlyout()
</script>

<template>
  <div class="flex min-w-0 flex-1 flex-col">
    <template v-if="selected && agent">
      <!-- One line at the flyout header's height; long titles truncate -->
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 text-sm">
        <span class="min-w-0 truncate font-medium"><TaskLink
          v-if="selected.taskRef"
          :task-ref="selected.taskRef"
        /><template v-else>{{ runRef(selected) }}</template> {{ selected.taskTitle ?? selected.epicTitle ?? '' }}</span>
        <AppBadge
          v-if="!isLive(selected)"
          class="shrink-0"
          :label="runBadge(selected).label"
          :color="runBadge(selected).color"
          variant="subtle"
          size="xs"
        />
        <span class="min-w-0 truncate text-xs text-muted-foreground">Run #{{ selected.number }} · {{ duration(selected.startedAt, selected.endedAt, now) }} · {{ runTokens(selected) }}<template v-if="selected.runnerName"> · on <span data-testid="run-runner">{{ selected.runnerName }}</span></template></span>
        <div class="ms-auto flex shrink-0 gap-2">
          <AppButton
            v-if="selected.taskRef"
            label="Open task"
            variant="outline"
            color="neutral"
            size="xs"
            @click="flyout.toggle(selected.taskRef)"
          />
          <AppButton
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
      <RunTranscriptPane
        :key="selected.id"
        :run="selected"
        :events="events"
        :agent-name="agent.name"
        :mine="sent[selected.id]"
      />
      <footer class="border-t border-border px-4 py-2">
        <RunComposer
          :key="selected.id"
          :view="view"
          :run="selected"
        />
      </footer>
    </template>
    <div
      v-else-if="agent"
      class="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
    >
      <span>{{ agentIdleNote(agent) }}</span>
    </div>
  </div>
</template>
