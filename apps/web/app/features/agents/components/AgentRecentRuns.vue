<script setup lang="ts">
import type { Run } from '@corral/contracts'
import type { AgentRuns } from '~/features/runs/composables/useAgentRuns'
import { duration, isLiveRun, projectColor, runRef, runTitle, timeAgo } from '~/utils/labels'

// The agent page's Recent runs card (design/agent.md, Activity): the live run
// pinned first, then the API's latest runs. Like the mobile rows, each shows
// its project's dot; outcome colour lives in the charts. Each row opens its run.
const props = defineProps<{ view: AgentRuns }>()
const { name, agent, runs, pending, error, now, load, project } = props.view
const router = useRouter()

const ordered = computed(() => [...runs.value.filter(isLiveRun), ...runs.value.filter(r => !isLiveRun(r))])
const meta = (run: Run) => [project(run)?.name, `Run #${run.number}`, duration(run.startedAt, run.endedAt, now.value)].filter(Boolean).join(' · ')
</script>

<template>
  <AppLoadError
    v-if="error"
    :title="error"
    :retry="load"
    class="m-3 w-auto"
  />
  <div
    v-else-if="pending"
    class="flex flex-col gap-2 p-3"
  >
    <UiSkeleton
      v-for="i in 5"
      :key="i"
      class="h-14 w-full"
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
      <button
        type="button"
        :class="['flex w-full flex-col gap-0.5 px-4 py-2.5 text-start text-sm hover:bg-muted/60', isLiveRun(run) && 'border-s-2 border-s-primary bg-primary/5']"
        @click="router.push(`/agents/${name}/${run.id}`)"
      >
        <span class="flex items-center gap-2">
          <span class="font-mono text-xs text-muted-foreground">{{ runRef(run) }}</span>
          <AppBadge
            v-if="isLiveRun(run)"
            label="Live"
            color="primary"
            variant="subtle"
            size="sm"
          />
          <span class="ms-auto text-xs text-muted-foreground/70 tabular-nums">{{ isLiveRun(run) ? duration(run.startedAt, null, now) : timeAgo(run.queuedAt, now) }}</span>
        </span>
        <span class="truncate">{{ runTitle(run) }}</span>
        <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            v-if="project(run)"
            class="size-2 shrink-0 rounded-full"
            :style="{ backgroundColor: projectColor(project(run)!) }"
            aria-hidden="true"
          />
          <span class="truncate">{{ meta(run) }}</span>
        </span>
        <span
          v-if="run.error"
          class="line-clamp-2 text-xs text-destructive"
          :title="run.error"
        >{{ run.error }}</span>
      </button>
    </li>
  </ul>
</template>
