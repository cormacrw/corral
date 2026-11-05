<script setup lang="ts">
import { TIMELINE_HOURS } from '~/features/agents/composables/useAgentsOverview'

// The Agents page (design/agent.md, Agents): headline numbers, a swimlane of
// every run in the last 12 hours, tokens by role and each agent's busy share
const { failed, error, retry, stats, runner, bars, tokens, agents } = useAgentsOverview()
</script>

<template>
  <AppPanel>
    <div
      class="flex flex-col gap-4 p-4 sm:p-6"
      data-testid="agents-overview"
    >
      <div class="flex items-center justify-between gap-3">
        <h1 class="text-xl font-semibold tracking-tight">
          Agents
        </h1>
        <AppButton
          label="Add agent"
          icon="i-hugeicons-add-01"
          to="/settings/agents"
          variant="outline"
          size="sm"
        />
      </div>

      <AppLoadError
        v-if="failed"
        title="Couldn't load recent runs"
        :description="error"
        :retry="retry"
      />

      <div class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Runs today"
          :value="stats.runsToday"
          :hint="stats.failedToday ? `${stats.failedToday} failed` : 'none failed'"
          icon="i-hugeicons-play"
        />
        <StatTile
          label="Tokens today"
          :value="stats.tokensToday"
          :delta="stats.tokenTrend ?? undefined"
          :delta-label="stats.tokenTrend === null ? undefined : `${stats.tokenTrend > 0 ? '+' : ''}${stats.tokenTrend}%`"
          good-when="down"
          :hint="stats.tokenTrend === null ? 'input, cache writes and output' : 'vs daily average'"
          icon="i-hugeicons-coins-01"
        />
        <StatTile
          label="Working"
          :value="`${stats.working}/${stats.total}`"
          :hint="stats.paused ? `${stats.paused} paused` : 'none paused'"
          icon="i-hugeicons-flash"
        />
        <StatTile
          label="Usage limits"
          :value="stats.limited"
          :hint="stats.limited === 1 ? 'agent waiting on its limit' : 'agents waiting on their limit'"
          icon="i-hugeicons-hourglass"
        />
        <StatTile
          label="Runner"
          :value="runner.label"
          :hint="runner.hint"
          icon="i-hugeicons-server-stack-01"
          class="col-span-2 md:col-span-1"
        />
      </div>

      <DashboardCard
        title="Runs"
        :subtitle="`Last ${TIMELINE_HOURS} hours, one lane per agent`"
      >
        <AgentsRunTimeline
          :bars="bars"
          :hours="TIMELINE_HOURS"
        />
      </DashboardCard>

      <div class="grid gap-4 lg:grid-cols-3">
        <DashboardCard
          title="Tokens by role"
          :subtitle="`Per day, last ${tokens.length} days`"
          class="lg:col-span-2"
        >
          <AgentsTokenChart :days="tokens" />
        </DashboardCard>

        <DashboardCard
          title="Agents"
          :subtitle="`Share of the last ${TIMELINE_HOURS} hours spent running`"
        >
          <AgentsBusyList
            :agents="agents"
            :hours="TIMELINE_HOURS"
          />
        </DashboardCard>
      </div>
    </div>
  </AppPanel>
</template>
