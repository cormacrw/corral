<script setup lang="ts">
import type { FlowMetrics, FlowMetricsQuery } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { QUEUE_WAIT_LABEL, ROLE, STATUS, formatMs } from '~/utils/labels'

// Coalesces the run.updated and task.updated of one lifecycle change, and
// still refreshes under a steady stream of events.
const REFRESH_DELAY_MS = 1000

const props = defineProps<{ slug: string, projectId: string }>()
const window = ref<FlowMetricsQuery['window']>('30d')
const metrics = ref<FlowMetrics | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
let request = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function cancelRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
}
async function fetchMetrics() {
  const current = ++request
  try {
    const result = await api.projects.flow(props.slug, window.value)
    if (current === request) {
      metrics.value = result
      error.value = null
    }
  } catch (e) {
    // A failed live refresh keeps the figures already on screen
    if (current === request && !metrics.value) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (current === request) loading.value = false
  }
}
function load() {
  cancelRefresh()
  loading.value = true
  error.value = null
  metrics.value = null
  return fetchMetrics()
}
function refresh() {
  refreshTimer ??= setTimeout(() => {
    refreshTimer = null
    void fetchMetrics()
  }, REFRESH_DELAY_MS)
}
watch([() => props.slug, window], load, { immediate: true })
const live = useLive()
onMounted(() => {
  const stop = live.subscribe((event) => {
    const projectId = event.type === 'task.updated'
      ? event.task.projectId
      : event.type === 'run.updated'
        ? event.run.projectId
        : event.type === 'task.deleted'
          ? event.projectId
          : null
    if (projectId === props.projectId) refresh()
  })
  onBeforeUnmount(() => {
    stop()
    cancelRefresh()
  })
})
const maxStatus = computed(() => Math.max(1, ...metrics.value?.timeInStatus.map(s => s.medianMs) ?? []))
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
      :aria-busy="loading"
    >
      <USkeleton
        v-if="loading"
        class="mt-4 h-32 w-full"
      />
      <UAlert
        v-else-if="error"
        class="mt-4"
        color="error"
        :title="error"
        :actions="[{ label: 'Retry', onClick: load }]"
      />
      <template v-else-if="metrics">
        <p
          v-if="metrics.mergedTaskCount === 0"
          class="py-6 text-sm text-muted"
        >
          No tasks merged in the last {{ window }}. Flow metrics will appear when tasks merge.
        </p>
        <template v-else>
          <p class="mt-2 text-xs text-muted">
            {{ metrics.mergedTaskCount }} tasks merged in the last {{ window }} · Lifetime through merge
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
