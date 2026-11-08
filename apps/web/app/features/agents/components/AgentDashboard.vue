<script setup lang="ts">
import type { AgentRuns } from '~/features/agents/composables/useAgentRuns'
import { ACTIVITY_DAYS, HOUR_TICKS, hourTick } from '~/features/agents/composables/useAgentActivity'

// An agent's page on the web with no run open (design/agent.md, Activity):
// its stat tiles, then the Agents dashboard's charts for this agent, with
// its recent runs beside them
const props = defineProps<{ view: AgentRuns }>()
const { agent, tiles, facts, pending, runsFailed, load } = props.view
const activity = useAgentActivity(() => agent.value?.id, load)
const { bars, outcomes, tokens, lengths, loading } = activity
// Either the history or the latest runs failed: nothing here can be trusted
const failed = computed(() => activity.failed.value || runsFailed.value)
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6"
    data-testid="agent-dashboard"
  >
    <div class="flex flex-col gap-2">
      <div class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <template v-if="pending && !runsFailed">
          <UiSkeleton
            v-for="i in 5"
            :key="i"
            class="h-[94px] rounded-xl"
            data-testid="tile-skeleton"
          />
        </template>
        <template v-else>
          <StatTile
            v-for="tile in tiles"
            :key="tile.label"
            :label="tile.label"
            :value="tile.value"
            :hint="tile.sub || undefined"
            :icon="tile.icon"
            :spark="tile.avg && !failed ? lengths ?? undefined : undefined"
            spark-color="var(--series-1)"
          />
        </template>
      </div>
      <p class="text-xs text-muted-foreground">
        {{ facts }}
      </p>
    </div>

    <AppLoadError
      v-if="failed"
      :title="`Couldn't load ${agent?.name}'s activity`"
      :description="activity.error.value ?? undefined"
      :retry="activity.retry"
    />

    <div class="grid gap-4 lg:grid-cols-3">
      <div class="flex min-w-0 flex-col gap-4 lg:col-span-2">
        <DashboardCard
          title="Runs"
          :subtitle="`Last ${ACTIVITY_DAYS} days, one lane per day, by time of day`"
        >
          <p
            v-if="failed"
            class="py-10 text-center text-sm text-muted-foreground"
          >
            Unavailable
          </p>
          <UiSkeleton
            v-else-if="loading"
            class="h-[246px] w-full"
          />
          <AgentsRunTimeline
            v-else
            :bars="bars"
            :hours="24"
            :ticks="HOUR_TICKS"
            :tick="hourTick"
            :empty="`No runs in the last ${ACTIVITY_DAYS} days.`"
          />
        </DashboardCard>

        <div class="grid gap-4 md:grid-cols-2">
          <DashboardCard
            title="Outcomes"
            :subtitle="`Finished runs per day, last ${outcomes.length} days`"
          >
            <p
              v-if="failed"
              class="flex h-[200px] items-center justify-center text-sm text-muted-foreground"
            >
              Unavailable
            </p>
            <UiSkeleton
              v-else-if="loading"
              class="h-[200px] w-full"
            />
            <AgentOutcomeChart
              v-else
              :days="outcomes"
            />
          </DashboardCard>
          <DashboardCard
            title="Tokens"
            :subtitle="`Per day, last ${tokens.length} days`"
          >
            <p
              v-if="failed"
              class="flex h-[200px] items-center justify-center text-sm text-muted-foreground"
            >
              Unavailable
            </p>
            <UiSkeleton
              v-else-if="loading"
              class="h-[200px] w-full"
            />
            <AgentsTokenChart
              v-else-if="agent"
              :days="tokens"
              :only="agent.role"
              :height="200"
            />
          </DashboardCard>
        </div>
      </div>

      <DashboardCard
        title="Recent runs"
        subtitle="Latest 50 · select one to open it"
        class="lg:max-h-[42rem]"
        body-class="p-0 pt-3"
      >
        <AgentRecentRuns :view="view" />
      </DashboardCard>
    </div>
  </div>
</template>
