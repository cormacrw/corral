<script setup lang="ts">
import { isActiveRun } from '@corral/core'
import type { AgentRuns } from '~/features/agents/composables/useAgentRuns'
import { runPath } from '~/utils/routes'

// The agent page's Recent runs card (design/agent.md, Activity): the live run
// pinned first, then the latest runs. Each row opens its run.
const props = defineProps<{ view: AgentRuns }>()
const { name, agent, runs, pending, runsFailed, error, now, load, project } = props.view
const router = useRouter()

const ordered = computed(() => [...runs.value.filter(r => isActiveRun(r.state)), ...runs.value.filter(r => !isActiveRun(r.state))])
</script>

<template>
  <!-- The runs, or a designer's design data, failed to load -->
  <AppLoadError
    v-if="error"
    :title="error"
    :retry="load"
    class="m-3 w-auto"
  />
  <template v-if="!runsFailed">
    <div
      v-if="pending"
      class="flex flex-col gap-2 p-3"
    >
      <UiSkeleton
        v-for="i in 5"
        :key="i"
        class="h-14 w-full"
        data-testid="run-skeleton"
      />
    </div>
    <p
      v-else-if="runs.length === 0"
      class="p-4 text-sm text-muted-foreground"
    >
      No runs yet. Runs show here once {{ agent?.name }} picks up its first task.
    </p>
    <ul
      v-else
      class="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain"
      data-testid="agent-recent-runs"
    >
      <li
        v-for="run in ordered"
        :key="run.id"
      >
        <AgentRunRow
          :run="run"
          :project="project(run)"
          :now="now"
          dashboard
          @click="router.push(runPath(name, run.id))"
        />
      </li>
    </ul>
  </template>
</template>
