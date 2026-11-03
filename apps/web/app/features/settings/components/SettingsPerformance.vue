<script setup lang="ts">
import type { PerfSummary, PerfVitals } from '@corral/contracts'
import { PERF_WINDOWS, type PerfWindow } from '@corral/contracts/client'
import { useQuery } from '@tanstack/vue-query'
import { performanceQuery } from '~/queries/performance'
import { formatLatency, formatVital, VITAL_RATING, vitalRating } from '~/features/settings/utils/performance'
import type { PerfColumn } from '~/features/settings/utils/performance'

type PerfRouteRow = PerfSummary['routes'][number]
type PerfPageRow = PerfSummary['pages'][number]

// Settings → Performance (design/settings.md): how the app has been responding
const range = ref<PerfWindow>('24h')
const query = useQuery(computed(() => performanceQuery(range.value)))
const summary = query.data
const error = computed(() => query.error.value?.message ?? null)

const vitals = computed(() => {
  const values = summary.value?.vitals
  if (!values) return []
  return (['LCP', 'INP', 'CLS'] as (keyof PerfVitals)[]).flatMap((metric) => {
    const value = values[metric]
    return value === null ? [] : [{ metric, value: formatVital(metric, value), rating: VITAL_RATING[vitalRating(metric, value)] }]
  })
})
const empty = computed(() => summary.value && !summary.value.routes.length && !summary.value.pages.length && !vitals.value.length)
const queries = (value: number | null) => value === null ? '–' : String(Number(value.toFixed(1)))

const ROUTE_COLUMNS: PerfColumn<PerfRouteRow>[] = [
  { heading: 'Count', value: row => row.count },
  { heading: 'p50', value: row => formatLatency(row.p50Ms) },
  { heading: 'p95', value: row => formatLatency(row.p95Ms), strong: true },
  { heading: 'Max', value: row => formatLatency(row.maxMs) },
  { heading: 'Avg DB', value: row => formatLatency(row.avgDbTimeMs) },
  { heading: 'Avg queries', value: row => queries(row.avgQueries) }
]
const PAGE_COLUMNS: PerfColumn<PerfPageRow>[] = [
  { heading: 'Count', value: row => row.count },
  { heading: 'p50', value: row => formatLatency(row.p50Ms) },
  { heading: 'p95', value: row => formatLatency(row.p95Ms), strong: true }
]
</script>

<template>
  <AppCard data-testid="settings-performance-card">
    <template #header>
      <div class="flex flex-wrap items-start gap-3">
        <div class="min-w-48 flex-1">
          <h2 class="font-medium">
            Performance
          </h2>
          <p class="text-xs text-muted-foreground">
            How quickly the app has been responding.
            <template v-if="summary">
              Rows with a p95 above {{ formatLatency(summary.slowThresholdMs) }} are marked slow.
            </template>
          </p>
        </div>
        <AppTabs
          v-model="range"
          :items="PERF_WINDOWS.map(value => ({ label: value, value }))"
          :content="false"
          aria-label="Time window"
          data-testid="perf-window"
        />
      </div>
    </template>

    <AppLoadError
      v-if="error"
      title="Could not load performance data"
      :description="error"
      :retry="query.refetch"
    />
    <UiSkeleton
      v-else-if="!summary"
      class="h-40 w-full"
    />
    <div
      v-else-if="empty"
      class="flex flex-col items-center gap-2 py-10 text-center"
      data-testid="perf-empty"
    >
      <Icon
        name="i-hugeicons-dashboard-speed-02"
        class="size-8 text-muted-foreground/70"
      />
      <p class="font-medium">
        No samples yet
      </p>
      <p class="max-w-sm text-sm text-muted-foreground">
        Nothing was recorded in this window. Data appears here as the app is used.
      </p>
    </div>
    <div
      v-else
      class="flex flex-col gap-6"
    >
      <section>
        <h3 class="mb-2 text-sm font-medium">
          Web Vitals
        </h3>
        <p
          v-if="!vitals.length"
          class="text-sm text-muted-foreground"
        >
          No Web Vitals in this window.
        </p>
        <ul
          v-else
          class="grid gap-3 sm:grid-cols-3"
        >
          <li
            v-for="vital in vitals"
            :key="vital.metric"
            class="rounded-md border border-border p-3"
            :data-testid="`perf-vital-${vital.metric}`"
          >
            <p class="text-xs text-muted-foreground">
              {{ vital.metric }} p75
            </p>
            <p class="my-1 text-lg font-semibold tabular-nums">
              {{ vital.value }}
            </p>
            <AppBadge
              :label="vital.rating.label"
              :color="vital.rating.color"
              variant="subtle"
              size="xs"
            />
          </li>
        </ul>
      </section>

      <SettingsPerfTable
        title="API routes"
        name-heading="Route"
        empty="No API requests in this window."
        :columns="ROUTE_COLUMNS"
        :rows="summary.routes"
        :slow-threshold-ms="summary.slowThresholdMs"
        data-testid="perf-routes"
      />
      <SettingsPerfTable
        title="Pages"
        name-heading="Page"
        empty="No page navigations in this window."
        :columns="PAGE_COLUMNS"
        :rows="summary.pages"
        :slow-threshold-ms="summary.slowThresholdMs"
        data-testid="perf-pages"
      />
    </div>
  </AppCard>
</template>
