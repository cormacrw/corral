<script setup lang="ts" generic="Row extends { name: string, p95Ms: number }">
import type { PerfColumn } from '~/features/settings/utils/performance'

// One Performance table: rows with a p95 above the threshold are marked slow
defineOptions({ inheritAttrs: false })
const props = defineProps<{ title: string, nameHeading: string, empty: string, columns: PerfColumn<Row>[], rows: Row[], slowThresholdMs: number }>()
const slow = (row: Row) => row.p95Ms > props.slowThresholdMs
</script>

<template>
  <section>
    <h3 class="mb-2 text-sm font-medium">
      {{ title }}
    </h3>
    <p
      v-if="!rows.length"
      class="text-sm text-muted-foreground"
    >
      {{ empty }}
    </p>
    <div
      v-else
      class="overflow-x-auto"
    >
      <table
        v-bind="$attrs"
        class="w-full text-sm"
      >
        <thead class="text-xs text-muted-foreground">
          <tr class="border-b border-border">
            <th class="min-w-48 px-2 py-2 text-start font-medium">
              {{ nameHeading }}
            </th>
            <th
              v-for="column in columns"
              :key="column.heading"
              class="px-2 py-2 text-end font-medium whitespace-nowrap"
            >
              {{ column.heading }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <tr
            v-for="row in rows"
            :key="row.name"
            :class="{ 'bg-warning/10': slow(row) }"
            :data-slow="slow(row) || undefined"
          >
            <td class="px-2 py-2">
              <span class="font-mono text-xs break-all">{{ row.name }}</span>
              <AppBadge
                v-if="slow(row)"
                label="Slow"
                color="warning"
                variant="subtle"
                size="xs"
                class="ml-2"
              />
            </td>
            <td
              v-for="column in columns"
              :key="column.heading"
              :class="['px-2 py-2 text-end tabular-nums whitespace-nowrap', column.strong && 'font-medium']"
            >
              {{ column.value(row) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
