<script setup lang="ts">
import { planThreadPath, runPath } from '~/utils/routes'
import { isActiveRun } from '@corral/core'
import type { Run } from '@corral/contracts'
import type { AgentRuns } from '~/features/agents/composables/useAgentRuns'
import { agentIdleNote } from '~/features/agents/utils/agents'
import { duration, timeAgo } from '~/utils/labels'

// An agent's page on mobile (design/agent.md, design/mobile.md): the
// header and stat tiles, then the current run and previous runs. Each run
// opens its transcript, or its linked Plan conversation for a PM turn.
const props = defineProps<{ view: AgentRuns }>()
const { name, agent, missing, runs, pending, error, now, current, load, project } = props.view

const previous = computed(() => runs.value.filter(r => !isActiveRun(r.state)))
const to = (run: Run) => run.role === 'pm' && run.planSessionId
  ? { path: planThreadPath(run.planSessionId), query: { project: run.projectId } }
  : runPath(name.value, run.id)
const meta = (run: Run) => [project(run)?.name, `Run #${run.number}`, isActiveRun(run.state) ? null : duration(run.startedAt, run.endedAt, now.value)].filter(Boolean).join(' · ')
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
    <AgentHeader
      :agent="agent"
      :view="view"
    />

    <AppLoadError
      v-if="error"
      :title="error"
      :retry="load"
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
        v-else-if="pending"
        class="h-16 w-full"
      />
      <p
        v-else
        class="text-sm text-muted-foreground"
      >
        {{ agentIdleNote(agent) }}
      </p>
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
      <UiSkeleton
        v-else-if="pending"
        class="mx-4 h-16"
      />
      <p
        v-else
        class="px-4 text-sm text-muted-foreground"
      >
        No runs yet.
      </p>
    </section>
  </div>
</template>
