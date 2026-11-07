<script setup lang="ts">
import type { Run } from '@corral/contracts'
import type { AgentRuns } from '~/features/runs/composables/useAgentRuns'
import { agentIdleNote, tileIcon } from '~/features/agents/utils/agents'
import { ACTIVITY_DAYS, hourTick, useAgentActivity } from '~/features/agents/composables/useAgentActivity'
import { duration, isLiveRun, plural, ROLE, runtimeLabel, timeAgo } from '~/utils/labels'

// An agent's page on mobile (design/agent.md, design/mobile.md): the
// header and stat tiles, the current run, its Activity charts, then previous
// runs. Each run opens its transcript, or its linked Plan conversation for a
// PM turn. Without the runs nothing is guessed: the run sections read
// "Unavailable", never idle or empty.
const props = defineProps<{ view: AgentRuns }>()
const { name, agent, status, limited, missing, runs, pending, error, runsFailed, now, current, today, tiles, facts, load, project, resume } = props.view

const activity = useAgentActivity(() => agent.value?.id, load)
const { bars, outcomes, tokens, lengths, loading: chartsLoading, failed: chartsFailed } = activity
// Loading tiles are skeletons; on an error they show their dashes
const tilesLoading = computed(() => pending.value && !runsFailed.value)

const previous = computed(() => runs.value.filter(r => !isLiveRun(r)))
const to = (run: Run) => run.role === 'pm' && run.planSessionId
  ? { path: `/plan/${run.planSessionId}`, query: { project: run.projectId } }
  : `/agents/${name.value}/${run.id}`
const meta = (run: Run) => [project(run)?.name, `Run #${run.number}`, isLiveRun(run) ? null : duration(run.startedAt, run.endedAt, now.value)].filter(Boolean).join(' · ')
</script>

<template>
  <MobilePageHeader />
  <AgentNotFound v-if="missing" />
  <div
    v-else-if="!agent"
    class="p-4"
  >
    <UiSkeleton class="h-16 w-48" />
  </div>
  <div
    v-else
    class="flex flex-col gap-5 py-4"
  >
    <header class="flex items-center gap-4 px-4">
      <AgentAvatar
        :name="agent.name"
        :working="agent.activeRuns > 0"
        size="3xl"
      />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 class="min-w-0 truncate text-2xl font-semibold text-foreground">
            {{ agent.name }}
          </h2>
          <AppBadge
            v-if="status"
            v-bind="status"
            variant="subtle"
          />
        </div>
        <p class="text-sm text-muted-foreground">
          {{ ROLE[agent.role] }} · {{ runtimeLabel(agent.runtime) }}<template v-if="!runsFailed && !pending">
            · {{ plural(today.length, 'run') }} today
          </template>
        </p>
        <p
          v-if="limited"
          class="text-xs text-muted-foreground"
        >
          Waiting on usage limit until {{ new Date(agent.pausedUntil!).toLocaleTimeString() }}
        </p>
        <AppButton
          v-if="limited"
          label="Resume now"
          variant="outline"
          color="neutral"
          size="sm"
          class="mt-2"
          @click="resume"
        />
      </div>
    </header>

    <div class="flex flex-col gap-3">
      <!-- The tiles scroll sideways rather than wrap -->
      <div class="flex snap-x gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1">
        <template v-if="tilesLoading">
          <UiSkeleton
            v-for="i in 3"
            :key="i"
            class="h-[94px] w-44 shrink-0 rounded-xl"
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
            :icon="tileIcon(tile.label)"
            :spark="tile.label.startsWith('Avg') && !runsFailed ? lengths ?? undefined : undefined"
            class="w-44 shrink-0 snap-start"
          />
        </template>
      </div>
      <p class="px-4 text-xs text-muted-foreground">
        {{ facts }}
      </p>
    </div>

    <AppLoadError
      v-if="error"
      :title="error"
      :retry="activity.retry"
      class="mx-4 w-auto"
    />

    <section
      aria-labelledby="agent-current-run"
      class="flex flex-col gap-2 px-4"
    >
      <h3
        id="agent-current-run"
        class="text-sm font-semibold text-foreground"
      >
        Current run
      </h3>
      <NuxtLink
        v-if="current"
        :to="to(current)"
        class="flex flex-col gap-1 rounded-lg border border-primary/50 p-3 ring-2 ring-primary/10"
        data-testid="current-run"
      >
        <AgentRunSummary
          :run="current"
          :project="project(current)"
          :detail="meta(current)"
          :when="duration(current.startedAt, null, now)"
          tabular
        />
      </NuxtLink>
      <UiSkeleton
        v-else-if="pending && !runsFailed"
        class="h-16 w-full"
      />
      <!-- Without the runs nobody knows if it's idle -->
      <p
        v-else-if="runsFailed"
        class="text-sm text-muted-foreground"
        data-testid="current-run-unavailable"
      >
        Unavailable
      </p>
      <p
        v-else
        class="text-sm text-muted-foreground"
      >
        {{ agentIdleNote(agent) }}
      </p>
    </section>

    <section
      aria-labelledby="agent-activity"
      class="flex flex-col gap-3 px-4"
      data-testid="agent-activity"
    >
      <h3
        id="agent-activity"
        class="text-sm font-semibold text-foreground"
      >
        Activity
      </h3>
      <AppLoadError
        v-if="chartsFailed"
        :title="`Couldn't load ${agent.name}'s activity`"
        :description="activity.error.value ?? undefined"
        :retry="activity.retry"
      />
      <template v-else>
        <DashboardCard
          title="Runs"
          :subtitle="`Last ${ACTIVITY_DAYS} days, by time of day`"
        >
          <UiSkeleton
            v-if="chartsLoading"
            class="h-[246px] w-full"
            data-testid="chart-skeleton"
          />
          <AgentsRunTimeline
            v-else
            :bars="bars"
            :hours="24"
            :ticks="[0, 6, 12, 18, 24]"
            :tick="hourTick"
            :empty="`No runs in the last ${ACTIVITY_DAYS} days.`"
          />
        </DashboardCard>
        <DashboardCard
          title="Outcomes"
          :subtitle="`Finished runs per day, last ${outcomes.length} days`"
        >
          <UiSkeleton
            v-if="chartsLoading"
            class="h-[180px] w-full"
            data-testid="chart-skeleton"
          />
          <AgentOutcomeChart
            v-else
            :days="outcomes"
            :height="180"
          />
        </DashboardCard>
        <DashboardCard
          title="Tokens"
          :subtitle="`Per day, last ${tokens.length} days`"
        >
          <UiSkeleton
            v-if="chartsLoading"
            class="h-[180px] w-full"
            data-testid="chart-skeleton"
          />
          <AgentsTokenChart
            v-else
            :days="tokens"
            :only="agent.role"
            :height="180"
          />
        </DashboardCard>
      </template>
    </section>

    <section
      aria-labelledby="agent-previous-runs"
      class="flex flex-col gap-2"
    >
      <h3
        id="agent-previous-runs"
        class="px-4 text-sm font-semibold text-foreground"
      >
        Previous runs
      </h3>
      <ul
        v-if="previous.length > 0"
        class="divide-y divide-border border-y border-border"
      >
        <li
          v-for="run in previous"
          :key="run.id"
        >
          <NuxtLink
            :to="to(run)"
            class="flex flex-col gap-1 px-4 py-3"
          >
            <AgentRunSummary
              :run="run"
              :project="project(run)"
              :detail="meta(run)"
              :when="timeAgo(run.queuedAt, now)"
            />
            <span
              v-if="run.error"
              class="line-clamp-3 text-xs text-destructive"
            >{{ run.error }}</span>
          </NuxtLink>
        </li>
      </ul>
      <div
        v-else-if="pending && !runsFailed"
        class="flex flex-col gap-2 px-4"
      >
        <UiSkeleton
          v-for="i in 3"
          :key="i"
          class="h-16"
          data-testid="run-skeleton"
        />
      </div>
      <p
        v-else-if="runsFailed"
        class="px-4 text-sm text-muted-foreground"
        data-testid="previous-runs-unavailable"
      >
        Unavailable
      </p>
      <p
        v-else-if="!current"
        class="px-4 text-sm text-muted-foreground"
      >
        No runs yet. Runs show here once {{ agent.name }} picks up its first task.
      </p>
      <p
        v-else
        class="px-4 text-sm text-muted-foreground"
      >
        No earlier runs.
      </p>
    </section>
  </div>
</template>
