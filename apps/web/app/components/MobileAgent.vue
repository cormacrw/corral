<script setup lang="ts">
import type { Run } from '@corral/contracts'
import type { AgentRuns } from '~/composables/useAgentRuns'
import { duration, isLiveRun, projectColor, ROLE, runBadge, timeAgo } from '~/utils/labels'

// An agent's page on mobile (design/agent.md, design/mobile.md): the
// header and stat tiles, then the current run and previous runs. Each run
// opens its transcript at /agents/:name/:runId.
const props = defineProps<{ view: AgentRuns }>()
const { name, agent, runs, error, now, current, today, tiles, facts, load, project } = props.view

const previous = computed(() => runs.value.filter(r => !isLiveRun(r)))
const limited = computed(() => !!agent.value?.pausedUntil && new Date(agent.value.pausedUntil).getTime() > now.value)
const status = computed(() => {
  if (!agent.value) return { label: 'Idle', color: 'neutral' as const }
  if (agent.value.activeRuns > 0) return { label: 'Working', color: 'success' as const }
  return { label: agent.value.paused ? 'Paused' : limited.value ? 'Waiting on usage limit' : 'Idle', color: 'neutral' as const }
})
const to = (run: Run) => `/agents/${name.value}/${run.id}`
const meta = (run: Run) => [project(run)?.name, `Run #${run.number}`, isLiveRun(run) ? null : duration(run.startedAt, run.endedAt, now.value)].filter(Boolean).join(' · ')
</script>

<template>
  <div
    v-if="!agent"
    class="p-4"
  >
    <USkeleton class="h-16 w-48" />
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
        <div class="flex items-center gap-2">
          <h2 class="text-2xl font-semibold text-highlighted">
            {{ agent.name }}
          </h2>
          <UBadge
            :label="status.label"
            :color="status.color"
            variant="subtle"
          />
        </div>
        <p class="text-sm text-muted">
          {{ ROLE[agent.role] }} · Claude Code · {{ today.length }} {{ today.length === 1 ? 'run' : 'runs' }} today
        </p>
        <p
          v-if="limited"
          class="text-xs text-muted"
        >
          Waiting on usage limit until {{ new Date(agent.pausedUntil!).toLocaleTimeString() }}
        </p>
      </div>
    </header>

    <div class="flex flex-col gap-3">
      <!-- The tiles scroll sideways rather than wrap -->
      <div class="flex snap-x gap-2 overflow-x-auto px-4 pb-1">
        <dl
          v-for="tile in tiles"
          :key="tile.label"
          class="w-34 shrink-0 snap-start rounded-lg border border-default p-3"
        >
          <dt class="truncate text-xs text-muted">
            {{ tile.label }}
          </dt>
          <dd class="text-2xl font-semibold text-highlighted tabular-nums">
            {{ tile.value }}
          </dd>
          <dd class="truncate text-xs text-muted">
            {{ tile.sub || '\u00A0' }}
          </dd>
        </dl>
      </div>
      <p class="px-4 text-xs text-muted">
        {{ facts }}
      </p>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      class="mx-4 w-auto"
      :actions="[{ label: 'Retry', onClick: load }]"
    />

    <section
      aria-labelledby="agent-current-run"
      class="flex flex-col gap-2 px-4"
    >
      <h3
        id="agent-current-run"
        class="text-sm font-semibold text-highlighted"
      >
        Current run
      </h3>
      <NuxtLink
        v-if="current"
        :to="to(current)"
        class="flex flex-col gap-1 rounded-lg border border-primary/50 p-3 ring-2 ring-primary/10"
        data-testid="current-run"
      >
        <span class="flex items-center gap-2">
          <span class="font-mono text-xs text-muted">{{ current.taskRef ?? 'Plan' }}</span>
          <UBadge
            label="Live"
            color="primary"
            variant="subtle"
            size="sm"
          />
          <span class="ms-auto text-xs text-muted tabular-nums">{{ duration(current.startedAt, null, now) }}</span>
        </span>
        <span class="truncate font-medium text-highlighted">{{ current.taskTitle ?? current.summary ?? 'PM turn' }}</span>
        <span class="flex items-center gap-1.5 text-xs text-muted">
          <span
            v-if="project(current)"
            class="size-2 shrink-0 rounded-full"
            :style="{ backgroundColor: projectColor(project(current)!) }"
            aria-hidden="true"
          />
          {{ meta(current) }}
        </span>
      </NuxtLink>
      <p
        v-else
        class="text-sm text-muted"
      >
        <template v-if="agent.role === 'pm'">
          {{ agent.name }} isn't running. {{ agent.name }} only runs when you send a message in Plan.
        </template>
        <template v-else>
          {{ agent.name }} is idle.
        </template>
      </p>
    </section>

    <section
      aria-labelledby="agent-previous-runs"
      class="flex flex-col gap-2"
    >
      <h3
        id="agent-previous-runs"
        class="px-4 text-sm font-semibold text-highlighted"
      >
        Previous runs
      </h3>
      <ul
        v-if="previous.length > 0"
        class="divide-y divide-default border-y border-default"
      >
        <li
          v-for="run in previous"
          :key="run.id"
        >
          <NuxtLink
            :to="to(run)"
            class="flex flex-col gap-1 px-4 py-3"
          >
            <span class="flex items-center gap-2">
              <span class="font-mono text-xs text-muted">{{ run.taskRef ?? 'Plan' }}</span>
              <UBadge
                :label="runBadge(run).label"
                :color="runBadge(run).color"
                variant="subtle"
                size="sm"
              />
              <span class="ms-auto text-xs text-muted">{{ timeAgo(run.queuedAt, now) }}</span>
            </span>
            <span class="truncate font-medium text-highlighted">{{ run.taskTitle ?? run.summary ?? 'PM turn' }}</span>
            <span class="flex items-center gap-1.5 text-xs text-muted">
              <span
                v-if="project(run)"
                class="size-2 shrink-0 rounded-full"
                :style="{ backgroundColor: projectColor(project(run)!) }"
                aria-hidden="true"
              />
              {{ meta(run) }}
            </span>
          </NuxtLink>
        </li>
      </ul>
      <p
        v-else
        class="px-4 text-sm text-muted"
      >
        No runs yet.
      </p>
    </section>
  </div>
</template>
