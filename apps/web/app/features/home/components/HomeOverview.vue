<script setup lang="ts">
// The web Home (design/home.md): five headline numbers, 30 days of merges,
// the parents touched most recently, open work by project and who's working
// On a phone (`mobile`, design/home.md#mobile) the same sections stack in
// the same order: no title row, the runner line on top, Needs you full width
const props = defineProps<{ mobile?: boolean }>()
const { loading, projects, kpis, throughput, openWork, epics, runs, now, runsLoading, runsFailed, runsError, retryRuns } = useHomeOverview()
const shell = useShell()
const runner = computed(() => {
  const runners = shell.runner?.runners ?? []
  const online = Boolean(shell.runner?.online)
  return { online, label: runners.length > 1 ? `${runners.filter(r => r.online).length} of ${runners.length} runners online` : `Runner ${online ? 'online' : 'offline'}` }
})
// A phone shows skeletons rather than zeros while the lists or runs load,
// and a dash for today's runs when they failed
const skeleton = computed(() => props.mobile && loading.value)
const runsToday = computed(() => props.mobile && (runsLoading.value || runsFailed.value) ? '–' : kpis.value.runsToday)
const runsHint = computed(() => !props.mobile ? kpis.value.runsHint : runsFailed.value ? 'couldn\'t load runs' : runsLoading.value ? undefined : kpis.value.runsHint)
</script>

<template>
  <AppPanel>
    <div
      :class="['flex flex-col gap-4', props.mobile ? 'mx-auto w-full max-w-[640px] p-4' : 'p-4 sm:p-6']"
      data-testid="home-overview"
    >
      <h1
        v-if="!props.mobile"
        class="text-xl font-semibold tracking-tight"
      >
        Home
      </h1>
      <p
        v-else
        class="flex items-center gap-1.5 text-sm text-muted-foreground"
        data-testid="home-runner"
      >
        <span
          :class="['size-2 rounded-full', runner.online ? 'bg-success' : 'bg-destructive']"
          aria-hidden="true"
        />
        {{ runner.label }} · All projects
      </p>

      <AppLoadError
        v-if="runsFailed"
        title="Couldn't load recent runs"
        :description="runsError"
        :retry="retryRuns"
        :class="props.mobile && '[&_button]:min-h-11 [&_button]:px-4'"
        data-testid="home-runs-error"
      />

      <div class="grid gap-4 lg:grid-cols-3">
        <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:col-span-3 xl:grid-cols-5">
          <NuxtLink
            to="/inbox"
            :class="props.mobile && 'col-span-2'"
            data-testid="home-needs-you"
          >
            <StatTile
              label="Needs you"
              :value="kpis.needsYou"
              :hint="kpis.blocked ? `${kpis.blocked} blocked or failed` : 'in the Inbox'"
              icon="i-hugeicons-inbox"
              :class="['h-full hover:bg-muted', props.mobile && 'active:bg-muted']"
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
            :value="runsToday"
            :hint="runsHint"
            icon="i-hugeicons-play"
            :class="props.mobile ? undefined : 'col-span-2 md:col-span-1'"
          />
        </div>

        <DashboardCard
          title="Throughput"
          subtitle="Tasks merged per day, last 30 days"
          class="lg:col-span-2"
        >
          <UiSkeleton
            v-if="skeleton"
            class="h-[150px] w-full"
          />
          <HomeThroughput
            v-else
            :rows="throughput"
            :projects="projects"
            :height="props.mobile ? 150 : undefined"
            :ticks="props.mobile ? 4 : undefined"
          />
        </DashboardCard>

        <DashboardCard
          title="Parents"
          subtitle="Touched most recently"
          class="lg:row-span-2"
        >
          <div
            v-if="skeleton"
            class="flex flex-col gap-4"
          >
            <UiSkeleton
              v-for="i in 3"
              :key="i"
              class="h-10 w-full"
            />
          </div>
          <HomeRecentEpics
            v-else
            :epics="props.mobile ? epics.slice(0, 4) : epics"
            :mobile="props.mobile"
          />
        </DashboardCard>

        <DashboardCard
          title="Open work by project"
          subtitle="Backlog not shown"
        >
          <div
            v-if="skeleton"
            class="flex flex-col gap-3"
          >
            <UiSkeleton
              v-for="i in 2"
              :key="i"
              class="h-6 w-full"
            />
          </div>
          <HomeOpenWork
            v-else
            :rows="openWork"
            :mobile="props.mobile"
          />
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
              :size="props.mobile ? 'sm' : 'xs'"
              trailing-icon="i-hugeicons-arrow-right-01"
              :class="props.mobile && '-my-2 -me-2 min-h-11'"
            />
          </template>
          <div
            v-if="props.mobile && runsLoading"
            class="flex flex-col gap-3"
          >
            <UiSkeleton
              v-for="i in 2"
              :key="i"
              class="h-10 w-full"
            />
          </div>
          <HomeLiveAgents
            v-else
            :agents="shell.agents"
            :runs="runs"
            :projects="projects"
            :now="now"
            :mobile="props.mobile"
          />
        </DashboardCard>
      </div>
    </div>
  </AppPanel>
</template>
