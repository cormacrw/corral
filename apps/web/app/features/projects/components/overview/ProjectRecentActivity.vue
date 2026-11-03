<script setup lang="ts">
import type { AuditEntry } from '@corral/contracts'
import TimeAgo from '~/components/shared/TimeAgo.vue'

defineProps<{
  history: AuditEntry[]
  actorName: (entry: AuditEntry) => string
  taskRefOf: (entry: AuditEntry) => string
  activityText: (entry: AuditEntry) => string
  mobile?: boolean
}>()
</script>

<template>
  <section>
    <OverviewHeading
      :mobile="mobile"
      class="mb-2"
    >
      Recent activity
    </OverviewHeading>
    <ol class="flex flex-col gap-2 text-sm">
      <li
        v-for="entry in history"
        :key="entry.id"
        class="flex gap-2"
      >
        <span
          class="mt-2 size-1.5 shrink-0 rounded-full bg-input"
          aria-hidden="true"
        />
        <span :class="['min-w-0', !mobile && 'truncate']">
          <span class="font-medium">{{ actorName(entry) }}</span>{{ ' ' }}
          <span class="text-muted-foreground">{{ activityText(entry) }}</span>{{ ' ' }}
          <TaskLink
            :task-ref="taskRefOf(entry)"
            class="font-mono text-xs"
          />
          <span class="ms-2 text-xs text-muted-foreground/70"><TimeAgo :at="entry.createdAt" /></span>
        </span>
      </li>
      <li
        v-if="history.length === 0"
        class="text-sm text-muted-foreground"
      >
        Nothing yet.
      </li>
    </ol>
  </section>
</template>
