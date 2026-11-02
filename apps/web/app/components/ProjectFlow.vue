<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { FlowMetricsQuery } from '@corral/contracts'
import { DEFAULT_FLOW_WINDOW, flowQuery } from '~/queries/projects'
import { QUEUE_WAIT_LABEL, ROLE, RUN_SESSION_LABELS, STATUS, dollars, formatMs } from '~/utils/labels'

const props = defineProps<{ slug: string }>()
const window = ref<FlowMetricsQuery['window']>(DEFAULT_FLOW_WINDOW)
// The project parent route keeps the default window current; events invalidate the rest
const { data: metrics, error, isPending, isPlaceholderData, refetch } = useQuery(computed(() => ({ ...flowQuery(props.slug, window.value), refetchOnMount: false })))
const maxStatus = computed(() => Math.max(1, ...metrics.value?.timeInStatus.map(s => s.medianMs) ?? []))
const formatTokens = (tokens: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)
function category(status: string) {
  if (status === 'human_review') return 'Human wait'
  if (status === 'in_progress' || status === 'agent_review') return 'Agent time'
  return 'Other wait'
}
</script>

<template>
  <section
    class="min-w-0 rounded-lg border border-default p-4"
    aria-label="Flow"
  >
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="font-semibold">
        Flow
      </h2>
      <div
        class="flex gap-1"
        role="group"
        aria-label="Flow window"
      >
        <UButton
          v-for="option in (['7d', '30d', '90d'] as const)"
          :key="option"
          :label="option"
          :aria-pressed="window === option"
          :variant="window === option ? 'solid' : 'outline'"
          color="neutral"
          size="sm"
          @click="window = option"
        />
      </div>
    </header>
    <div
      aria-live="polite"
      :aria-busy="isPending || isPlaceholderData"
    >
      <USkeleton
        v-if="isPending"
        class="mt-4 h-32 w-full"
      />
      <UAlert
        v-else-if="error && !metrics"
        class="mt-4"
        color="error"
        :title="error.message"
        :actions="[{ label: 'Retry', onClick: () => refetch() }]"
      />
      <template v-else-if="metrics">
        <section
          class="mt-4 rounded-md border border-default p-3"
          aria-label="Rework"
        >
          <h3 class="text-sm font-medium">
            Rework in the last {{ metrics.window }}
          </h3>
          <dl class="mt-2 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt class="text-xs text-muted">
                Fixes
              </dt>
              <dd class="tabular-nums">
                {{ metrics.fixes.reReviewed }} reviewed again, {{ metrics.fixes.skippedReview }} kept approval
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted">
                Developer runs on epics
              </dt>
              <dd class="tabular-nums">
                {{ metrics.fixes.epicDeveloperRuns }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted">
                Reviews per epic
              </dt>
              <dd class="tabular-nums">
                {{ metrics.epicReviews.perEpic.toFixed(1) }} ({{ metrics.epicReviews.reviews }} across {{ metrics.epicReviews.epics }})
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted">
                Tokens: first build vs follow-up
              </dt>
              <dd class="tabular-nums">
                {{ formatTokens(metrics.tokens.firstBuild) }} vs {{ formatTokens(metrics.tokens.followUp) }}
              </dd>
            </div>
          </dl>
          <div
            v-if="metrics.sessions.length"
            class="mt-3 overflow-x-auto"
          >
            <table class="w-full text-sm">
              <caption class="mb-1 text-left text-xs text-muted">
                Developer runs by session start. Revisions follow a task's first submission. Weighted cost leaves out fresh input and runs with unknown cache writes.
              </caption>
              <thead class="text-left text-xs text-muted">
                <tr>
                  <th class="pr-3 font-normal">
                    Session
                  </th>
                  <th class="pr-3 font-normal">
                    Runs
                  </th>
                  <th class="pr-3 font-normal">
                    Input
                  </th>
                  <th class="pr-3 font-normal">
                    Cache write
                  </th>
                  <th class="pr-3 font-normal">
                    Cache read
                  </th>
                  <th class="pr-3 font-normal">
                    Output
                  </th>
                  <th class="font-normal">
                    Weighted cost per run
                  </th>
                </tr>
              </thead>
              <tbody class="tabular-nums">
                <tr
                  v-for="row in metrics.sessions"
                  :key="`${row.round}-${row.sessionStart}`"
                >
                  <td class="pr-3">
                    {{ row.round === 'revision' ? 'Revision' : 'Other' }}: {{ RUN_SESSION_LABELS[row.sessionStart].toLowerCase() }}
                  </td>
                  <td class="pr-3">
                    {{ row.runs }}
                  </td>
                  <td class="pr-3">
                    {{ formatTokens(row.inputTokens) }}
                  </td>
                  <td class="pr-3">
                    {{ formatTokens(row.cacheWriteTokens) }}
                  </td>
                  <td class="pr-3">
                    {{ formatTokens(row.cacheReadTokens) }}
                  </td>
                  <td class="pr-3">
                    {{ formatTokens(row.outputTokens) }}
                  </td>
                  <td>
                    {{ row.costedRuns ? `${dollars(row.weightedCost / row.costedRuns)} (${row.costedRuns} ${row.costedRuns === 1 ? 'run' : 'runs'})` : 'Not reported' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <p
          v-if="metrics.mergedTaskCount === 0"
          class="py-6 text-sm text-muted"
        >
          No tasks merged in the last {{ metrics.window }}. Flow metrics will appear when tasks merge.
        </p>
        <template v-else>
          <p class="mt-2 text-xs text-muted">
            {{ metrics.mergedTaskCount }} tasks merged in the last {{ metrics.window }} · Lifetime through merge
          </p>
          <div class="mt-4 grid grid-cols-2 gap-4">
            <dl
              v-for="tile in [{ label: 'Lead time', value: metrics.leadTime }, { label: 'Cycle time', value: metrics.cycleTime }]"
              :key="tile.label"
            >
              <dt class="text-sm text-muted">
                {{ tile.label }}
              </dt>
              <dd class="text-2xl font-semibold tabular-nums">
                {{ formatMs(tile.value.medianMs) }}
              </dd>
              <dd class="text-xs text-muted">
                Median · p90 {{ formatMs(tile.value.p90Ms) }}
              </dd>
            </dl>
          </div>
          <div class="mt-6 grid gap-6 lg:grid-cols-2">
            <div>
              <h3 class="text-sm font-medium">
                Time per status
              </h3>
              <p class="mt-1 text-xs text-muted">
                Median per task · p90 shown alongside
              </p>
              <ul class="mt-3 space-y-3">
                <li
                  v-for="row in metrics.timeInStatus"
                  :key="row.status"
                >
                  <div class="flex flex-wrap justify-between gap-x-2 text-xs">
                    <span>{{ STATUS[row.status].label }} · {{ category(row.status) }}</span>
                    <span class="tabular-nums">{{ formatMs(row.medianMs) }} · p90 {{ formatMs(row.p90Ms) }}</span>
                  </div>
                  <div
                    class="mt-1 h-2 rounded-full bg-accented"
                    aria-hidden="true"
                  >
                    <div
                      class="h-full rounded-full"
                      :class="row.status === 'human_review' ? 'bg-warning' : category(row.status) === 'Agent time' ? 'bg-primary' : 'bg-neutral-400'"
                      :style="{ width: `${100 * row.medianMs / maxStatus}%` }"
                    />
                  </div>
                </li>
              </ul>
            </div>
            <div class="min-w-0">
              <h3 class="text-sm font-medium">
                Runs by role
              </h3>
              <p class="mt-1 text-xs text-muted">
                Median · p90
              </p>
              <dl class="mt-3 space-y-3">
                <div
                  v-for="row in metrics.runsByRole"
                  :key="row.role"
                  class="text-sm"
                >
                  <dt class="font-medium">
                    {{ ROLE[row.role] }}
                  </dt>
                  <dd class="mt-1 text-xs text-muted">
                    Run duration: {{ formatMs(row.duration.medianMs) }} · p90 {{ formatMs(row.duration.p90Ms) }}
                  </dd>
                  <dd class="text-xs text-muted">
                    {{ QUEUE_WAIT_LABEL }}: {{ formatMs(row.queueWait.medianMs) }} · p90 {{ formatMs(row.queueWait.p90Ms) }}
                  </dd>
                </div>
              </dl>
              <p
                v-if="!metrics.runsByRole.length"
                class="mt-3 text-sm text-muted"
              >
                No timed runs for these tasks.
              </p>
              <h3 class="mt-6 text-sm font-medium">
                Slowest tasks
              </h3>
              <ul class="mt-2 divide-y divide-default">
                <li
                  v-for="task in metrics.slowestTasks"
                  :key="task.ref"
                >
                  <NuxtLink
                    :to="`/tasks/${task.ref}`"
                    class="flex flex-wrap justify-between gap-2 py-2 text-sm hover:text-primary hover:underline"
                  >
                    <span class="font-mono">{{ task.ref }}</span>
                    <span class="text-xs text-muted">{{ formatMs(task.leadTimeMs) }} lead · {{ STATUS[task.dominantStatus].label }}</span>
                  </NuxtLink>
                </li>
              </ul>
            </div>
          </div>
        </template>
      </template>
    </div>
  </section>
</template>
