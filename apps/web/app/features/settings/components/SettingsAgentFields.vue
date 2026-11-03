<script setup lang="ts">
import type { Agent, AgentRuntime } from '@corral/contracts'
import type { AgentSettings } from '~/features/settings/composables/useAgentSettings'

// The fields both layouts edit. `compact` sizes them for the desktop row;
// otherwise they're full width. The `after-runtime` slot takes what only one
// layout has there.
const props = defineProps<{ agent: Agent, settings: AgentSettings, compact?: boolean }>()
const { runtimeItems, patchAgent, renameAgent, patchWakeInterval } = props.settings
</script>

<template>
  <AppFormField
    v-slot="{ id }"
    label="Name"
  >
    <AppInput
      :id="id"
      :model-value="agent.name"
      :maxlength="80"
      :size="compact ? 'xs' : 'lg'"
      :class="compact ? 'w-32' : 'w-full'"
      @change="renameAgent(agent, $event)"
    />
  </AppFormField>
  <AppFormField
    v-if="agent.role !== 'pm'"
    v-slot="{ id }"
    label="Runtime"
    :help="agent.activeRuns > 0 ? 'Changes once its runs end' : undefined"
  >
    <AppSelectMenu
      :id="id"
      :model-value="agent.runtime"
      :items="runtimeItems(agent)"
      :disabled="agent.activeRuns > 0"
      :class="compact ? 'w-28' : 'w-full'"
      @update:model-value="$event !== agent.runtime && patchAgent(agent, { runtime: $event as AgentRuntime })"
    />
  </AppFormField>
  <slot name="after-runtime" />
  <AppFormField
    v-if="agent.role !== 'pm'"
    label="Wake interval (min)"
    help="Blank: every check"
  >
    <AppNumberInput
      :model-value="agent.wakeIntervalSeconds === null ? null : agent.wakeIntervalSeconds / 60"
      :min="1"
      placeholder="None"
      :aria-label="`Wake interval for ${agent.name} in minutes`"
      :class="compact ? 'w-28' : 'w-full'"
      @update:model-value="patchWakeInterval(agent, $event)"
    />
  </AppFormField>
</template>
