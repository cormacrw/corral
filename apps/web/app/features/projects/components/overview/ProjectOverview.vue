<script setup lang="ts">
import type { ProjectOverview } from '~/features/projects/composables/useProjectOverview'

// Project overview (design/project-overview.md, design/mobile.md): the same
// sections on the web and in one column on a phone
const props = defineProps<{ overview: ProjectOverview, mobile?: boolean }>()
const { project, tasks, loading, inboxLoading, runs, history, error, load, needsYou, pmName, taskOf, actorName, taskRefOf, activityText } = props.overview
</script>

<template>
  <div
    v-if="!project"
    :class="mobile ? 'flex flex-col gap-3 p-4' : 'p-6'"
  >
    <template v-if="mobile">
      <UiSkeleton class="h-11 w-56" />
      <UiSkeleton class="h-24 w-full" />
    </template>
    <UiSkeleton
      v-else
      class="h-8 w-64"
    />
  </div>
  <div
    v-else
    :class="mobile ? 'flex flex-col gap-6 py-4' : 'mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-6'"
  >
    <ProjectOverviewHeader
      :project="project"
      :pm-name="pmName"
      :mobile="mobile"
    />
    <ProjectActiveRuns
      :runs="runs"
      :task-of="taskOf"
      :mobile="mobile"
    />
    <AppLoadError
      v-if="error"
      :title="error"
      :retry="load"
      :class="mobile && 'mx-4 w-auto'"
    />
    <div
      v-if="!loading && tasks.length === 0"
      :class="['rounded-lg border border-border text-center', mobile ? 'mx-4 p-6' : 'p-8']"
    >
      <p class="mb-3 text-muted-foreground">
        Plan your first task with {{ pmName }}
      </p>
      <AppButton
        :to="`/plan?project=${project.id}`"
        :label="`Plan with ${pmName}`"
      />
    </div>
    <OverviewTiles
      :overview="overview"
      :mobile="mobile"
    />
    <ProjectOverviewTabs :overview="overview">
      <template #needs-you>
        <ProjectNeedsYou
          :items="needsYou"
          :loading="inboxLoading"
          :mobile="mobile"
        />
      </template>
      <template #activity>
        <ProjectRecentActivity
          :history="history"
          :actor-name="actorName"
          :task-ref-of="taskRefOf"
          :activity-text="activityText"
          :mobile="mobile"
        />
      </template>
    </ProjectOverviewTabs>
  </div>
</template>
