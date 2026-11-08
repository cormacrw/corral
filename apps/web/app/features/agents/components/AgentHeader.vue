<script setup lang="ts">
import { ROLE_LABELS } from '@corral/core'
import type { Agent } from '@corral/contracts'
import type { AgentRuns } from '~/features/agents/composables/useAgentRuns'
import { plural, runtimeLabel } from '~/utils/labels'
import { settingsPath } from '~/utils/routes'

// An agent's header (design/agent.md), on either layout. A phone puts the
// usage-limit note under the name; its header has the settings action
// already. Today's run count waits for the runs, and is left out if they fail.
const props = defineProps<{ agent: Agent, view: AgentRuns }>()
const { status, limited, today, pending, runsFailed, resume } = props.view
const mobile = useDevice().isMobile
const until = computed(() => new Date(props.agent.pausedUntil!).toLocaleTimeString())
</script>

<template>
  <header :class="mobile ? 'flex items-center gap-4 px-4' : 'flex items-center gap-3 border-b border-border px-4 py-3'">
    <AgentAvatar
      :name="agent.name"
      :working="agent.activeRuns > 0"
      :size="mobile ? '3xl' : 'lg'"
    />
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <component
          :is="mobile ? 'h2' : 'h1'"
          :class="mobile ? 'min-w-0 truncate text-2xl font-semibold text-foreground' : 'min-w-0 truncate text-lg font-semibold'"
        >
          {{ agent.name }}
        </component>
        <AppBadge
          v-if="status"
          v-bind="status"
          variant="subtle"
        />
      </div>
      <p class="text-sm text-muted-foreground">
        {{ ROLE_LABELS[agent.role] }} · <span data-testid="agent-runtime-label">{{ runtimeLabel(agent.runtime) }}</span><template v-if="!pending && !runsFailed">
          · {{ plural(today.length, 'run') }} today
        </template>
        <span v-if="limited && !mobile"> · Waiting on usage limit until {{ until }}</span>
      </p>
      <template v-if="limited && mobile">
        <p class="text-xs text-muted-foreground">
          Waiting on usage limit until {{ until }}
        </p>
        <AppButton
          label="Resume now"
          variant="outline"
          color="neutral"
          size="sm"
          class="mt-2"
          @click="resume"
        />
      </template>
    </div>
    <template v-if="!mobile">
      <AppButton
        v-if="limited"
        label="Resume now"
        variant="outline"
        color="neutral"
        size="sm"
        @click="resume"
      />
      <AppButton
        :to="settingsPath('agents')"
        label="Agent settings"
        variant="outline"
        color="neutral"
        size="sm"
      />
    </template>
  </header>
</template>
