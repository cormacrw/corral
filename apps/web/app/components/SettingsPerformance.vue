<script setup lang="ts">
import { PERF_WINDOWS, type PerfVitals, type PerfWindow } from '@corral/contracts'
import { useQuery } from '@tanstack/vue-query'
import { performanceQuery } from '~/queries/performance'
import { formatLatency, formatVital, VITAL_RATING, vitalRating } from '~/utils/performance'

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
const slow = (p95Ms: number) => p95Ms > (summary.value?.slowThresholdMs ?? Infinity)
const queries = (value: number | null) => value === null ? '–' : String(Number(value.toFixed(1)))
</script>

<template>
  <UCard data-testid="settings-performance-card">
    <template #header>
      <div class="flex flex-wrap items-start gap-3">
        <div class="min-w-48 flex-1">
          <h2 class="font-medium">
            Performance
          </h2>
          <p class="text-xs text-muted">
            How quickly the app has been responding.
            <template v-if="summary">
              Rows with a p95 above {{ formatLatency(summary.slowThresholdMs) }} are marked slow.
            </template>
          </p>
        </div>
        <UTabs
          v-model="range"
          :items="PERF_WINDOWS.map(value => ({ label: value, value }))"
          size="sm"
          :content="false"
          aria-label="Time window"
          data-testid="perf-window"
        />
      </div>
    </template>

    <UAlert
      v-if="error"
      color="warning"
      variant="subtle"
      title="Could not load performance data"
      :description="error"
    />
    <USkeleton
      v-else-if="!summary"
      class="h-40 w-full"
    />
    <div
      v-else-if="empty"
      class="flex flex-col items-center gap-2 py-10 text-center"
      data-testid="perf-empty"
    >
      <UIcon
        name="i-lucide-gauge"
        class="size-8 text-dimmed"
      />
      <p class="font-medium">
        No samples yet
      </p>
      <p class="max-w-sm text-sm text-muted">
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
          class="text-sm text-muted"
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
            class="rounded-md border border-default p-3"
            :data-testid="`perf-vital-${vital.metric}`"
          >
            <p class="text-xs text-muted">
              {{ vital.metric }} p75
            </p>
            <p class="my-1 text-lg font-semibold tabular-nums">
              {{ vital.value }}
            </p>
            <UBadge
              :label="vital.rating.label"
              :color="vital.rating.color"
              variant="subtle"
              size="xs"
            />
          </li>
        </ul>
      </section>

      <section>
        <h3 class="mb-2 text-sm font-medium">
          API routes
        </h3>
        <p
          v-if="!summary.routes.length"
          class="text-sm text-muted"
        >
          No API requests in this window.
        </p>
        <div
          v-else
          class="overflow-x-auto"
        >
          <table
            class="w-full text-sm"
            data-testid="perf-routes"
          >
            <thead class="text-xs text-muted">
              <tr class="border-b border-default">
                <th class="min-w-48 px-2 py-2 text-start font-medium">
                  Route
                </th>
                <th
                  v-for="heading in ['Count', 'p50', 'p95', 'Max', 'Avg DB', 'Avg queries']"
                  :key="heading"
                  class="px-2 py-2 text-end font-medium whitespace-nowrap"
                >
                  {{ heading }}
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr
                v-for="row in summary.routes"
                :key="row.name"
                :class="{ 'bg-warning/10': slow(row.p95Ms) }"
                :data-slow="slow(row.p95Ms) || undefined"
              >
                <td class="px-2 py-2">
                  <span class="font-mono text-xs break-all">{{ row.name }}</span>
                  <UBadge
                    v-if="slow(row.p95Ms)"
                    label="Slow"
                    color="warning"
                    variant="subtle"
                    size="xs"
                    class="ml-2"
                  />
                </td>
                <td class="px-2 py-2 text-end tabular-nums">
                  {{ row.count }}
                </td>
                <td class="px-2 py-2 text-end tabular-nums whitespace-nowrap">
                  {{ formatLatency(row.p50Ms) }}
                </td>
                <td class="px-2 py-2 text-end font-medium tabular-nums whitespace-nowrap">
                  {{ formatLatency(row.p95Ms) }}
                </td>
                <td class="px-2 py-2 text-end tabular-nums whitespace-nowrap">
                  {{ formatLatency(row.maxMs) }}
                </td>
                <td class="px-2 py-2 text-end tabular-nums whitespace-nowrap">
                  {{ formatLatency(row.avgDbTimeMs) }}
                </td>
                <td class="px-2 py-2 text-end tabular-nums">
                  {{ queries(row.avgQueries) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 class="mb-2 text-sm font-medium">
          Pages
        </h3>
        <p
          v-if="!summary.pages.length"
          class="text-sm text-muted"
        >
          No page navigations in this window.
        </p>
        <div
          v-else
          class="overflow-x-auto"
        >
          <table
            class="w-full text-sm"
            data-testid="perf-pages"
          >
            <thead class="text-xs text-muted">
              <tr class="border-b border-default">
                <th class="min-w-48 px-2 py-2 text-start font-medium">
                  Page
                </th>
                <th
                  v-for="heading in ['Count', 'p50', 'p95']"
                  :key="heading"
                  class="px-2 py-2 text-end font-medium"
                >
                  {{ heading }}
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr
                v-for="row in summary.pages"
                :key="row.name"
                :class="{ 'bg-warning/10': slow(row.p95Ms) }"
                :data-slow="slow(row.p95Ms) || undefined"
              >
                <td class="px-2 py-2">
                  <span class="font-mono text-xs break-all">{{ row.name }}</span>
                  <UBadge
                    v-if="slow(row.p95Ms)"
                    label="Slow"
                    color="warning"
                    variant="subtle"
                    size="xs"
                    class="ml-2"
                  />
                </td>
                <td class="px-2 py-2 text-end tabular-nums">
                  {{ row.count }}
                </td>
                <td class="px-2 py-2 text-end tabular-nums whitespace-nowrap">
                  {{ formatLatency(row.p50Ms) }}
                </td>
                <td class="px-2 py-2 text-end font-medium tabular-nums whitespace-nowrap">
                  {{ formatLatency(row.p95Ms) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </UCard>
</template>
