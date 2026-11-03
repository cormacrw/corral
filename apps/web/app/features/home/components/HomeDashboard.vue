<script setup lang="ts">
const { agentsLoaded, runner, projectId, projectItems, epics, counts, loading, stages, attention, today, agents, runsFailed, runsError, retryRuns } = useHomeDashboard()
</script>

<template>
  <AppPanel>
    <div
      class="mx-auto flex w-full max-w-[640px] flex-col gap-4 p-4"
      data-testid="home-dashboard"
    >
      <HomeScope
        v-model="projectId"
        :runner="runner"
        :items="projectItems"
      />
      <HomeCounts
        :counts="counts"
        :loading="loading"
      />
      <HomeUsage
        :today="today"
        :failed="runsFailed"
      />
      <AppLoadError
        v-if="runsFailed"
        title="Couldn't load today's runs"
        :description="runsError"
        :retry="retryRuns"
        data-testid="home-runs-error"
      />
      <HomeStages
        :stages="stages"
        :counts="counts"
        :attention="attention"
      />
      <HomeAgents
        :agents="agents"
        :loaded="agentsLoaded"
      />
      <HomeParents
        :epics="epics"
        :show-project="projectId === 'all'"
      />
    </div>
  </AppPanel>
</template>
