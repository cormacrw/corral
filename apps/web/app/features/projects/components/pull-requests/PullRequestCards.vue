<script setup lang="ts">
import type { PullRequestRow } from '~/features/projects/composables/usePullRequests'

// Phones: one card per PR
defineProps<{ rows: PullRequestRow[] }>()
const flyout = useTaskFlyout()
</script>

<template>
  <ul class="flex shrink-0 flex-col gap-3 p-4">
    <li
      v-for="row in rows"
      :key="row.pr.taskRef"
    >
      <button
        type="button"
        class="flex w-full flex-col gap-2 rounded-lg border border-border bg-background p-3 text-start active:bg-muted"
        @click="flyout.open(row.pr.taskRef)"
      >
        <span class="flex items-center gap-2 text-xs text-muted-foreground">
          <span class="font-mono">{{ row.pr.taskRef }}</span>
          <span>· PR #{{ row.pr.pr.number }}</span>
          <StatusBadge
            :status="row.pr.taskStatus"
            size="xs"
            class="ms-auto"
          />
        </span>
        <span class="text-sm font-medium text-foreground">{{ row.pr.taskTitle }}</span>
        <dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
          <template
            v-for="cell in row.cells"
            :key="cell.term"
          >
            <dt class="text-muted-foreground">
              {{ cell.term }}
            </dt>
            <dd>
              <AppBadge
                :label="cell.label"
                :color="cell.color"
                variant="subtle"
                size="sm"
              />
            </dd>
          </template>
        </dl>
        <PullRequestMerge
          :row="row"
          class="border-t border-border pt-2 text-sm"
        />
      </button>
    </li>
  </ul>
</template>
