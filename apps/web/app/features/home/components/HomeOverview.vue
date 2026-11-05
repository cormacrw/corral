<script setup lang="ts">
// The web Home (design/home.md): five headline numbers, 30 days of merges,
// the parents touched most recently, open work by project and who's working
const { loading, projects, kpis, throughput, openWork, epics, runs, now, runsFailed, runsError, retryRuns } = useHomeOverview()
const shell = useShell()
</script>

<template>
  <AppPanel>
    <div
      class="flex flex-col gap-4 p-4 sm:p-6"
      data-testid="home-overview"
    >
      <h1 class="text-xl font-semibold tracking-tight">
        Home
      </h1>

      <AppLoadError
        v-if="runsFailed"
        title="Couldn't load recent runs"
        :description="runsError"
        :retry="retryRuns"
      />

      <div class="grid gap-4 lg:grid-cols-3">
        <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:col-span-3 xl:grid-cols-5">
          <NuxtLink to="/inbox">
            <StatTile
              label="Needs you"
              :value="kpis.needsYou"
              :hint="kpis.blocked ? `${kpis.blocked} blocked or failed` : 'in the Inbox'"
              icon="i-hugeicons-inbox"
              class="h-full hover:bg-muted"
            />
          </NuxtLink>
          <StatTile
            label="In flight"
            :value="loading ? '–' : kpis.inFlight"
            :hint="`${kpis.working} of ${kpis.agents} agents working`"
            icon="i-hugeicons-flash"
          />
          <StatTile
            label="Merged this week"
            :value="loading ? '–' : kpis.mergedThisWeek"
            :delta="loading ? undefined : kpis.mergedDelta"
            hint="vs last week"
            :spark="kpis.mergedSpark"
            icon="i-hugeicons-git-merge"
          />
          <StatTile
            label="Median cycle time"
            :value="kpis.cycle?.value ?? '–'"
            :delta="kpis.cycle?.delta"
            :delta-label="kpis.cycle?.deltaLabel"
            good-when="down"
            :hint="kpis.cycle ? `${kpis.cycle.count} merged in 7 days` : 'nothing merged in 7 days'"
            icon="i-hugeicons-time-quarter-pass"
          />
          <StatTile
            label="Runs today"
            :value="kpis.runsToday"
            :hint="kpis.runsHint"
            icon="i-hugeicons-play"
            class="col-span-2 md:col-span-1"
          />
        </div>

        <DashboardCard
          title="Throughput"
          subtitle="Tasks merged per day, last 30 days"
          class="lg:col-span-2"
        >
          <HomeThroughput
            :rows="throughput"
            :projects="projects"
          />
        </DashboardCard>

        <DashboardCard
          title="Tasks with subtasks"
          subtitle="Touched most recently"
          class="lg:row-span-2"
        >
          <HomeRecentEpics :epics="epics" />
        </DashboardCard>

        <DashboardCard
          title="Open work by project"
          subtitle="Backlog not shown"
        >
          <HomeOpenWork :rows="openWork" />
        </DashboardCard>

        <DashboardCard
          title="Agents"
          subtitle="Running now"
        >
          <template #actions>
            <AppButton
              label="All agents"
              to="/agents"
              variant="ghost"
              size="xs"
              trailing-icon="i-hugeicons-arrow-right-01"
            />
          </template>
          <HomeLiveAgents
            :agents="shell.agents"
            :runs="runs"
            :projects="projects"
            :now="now"
          />
        </DashboardCard>
      </div>
    </div>
  </AppPanel>
</template>
