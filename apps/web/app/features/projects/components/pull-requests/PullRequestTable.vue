<script setup lang="ts">
import type { PullRequestRow } from '~/features/projects/composables/usePullRequests'

// Desktop: a table; a row opens the task flyout
defineProps<{ rows: PullRequestRow[] }>()
const flyout = useTaskFlyout()
const COLUMNS = ['PR', 'Review', 'CI', 'Rebase', 'Evidence']
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto overscroll-contain">
    <table class="w-full text-sm">
      <thead class="sticky top-0 bg-background text-start text-xs text-muted-foreground">
        <tr class="border-b border-border">
          <th class="px-4 py-2 text-start font-medium">
            Task
          </th>
          <th
            v-for="column in COLUMNS"
            :key="column"
            class="px-2 py-2 text-start font-medium"
          >
            {{ column }}
          </th>
          <th class="px-4 py-2 text-start font-medium">
            Merge
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.pr.taskRef"
          tabindex="0"
          :aria-selected="flyout.ref.value === row.pr.taskRef"
          :class="['cursor-pointer border-b border-border align-top hover:bg-muted focus-visible:bg-muted focus-visible:outline-none', flyout.ref.value === row.pr.taskRef && 'bg-muted']"
          @click="flyout.toggle(row.pr.taskRef)"
          @keydown.enter.prevent="flyout.toggle(row.pr.taskRef)"
          @keydown.space.prevent="flyout.toggle(row.pr.taskRef)"
        >
          <!-- Takes the room left over, so the title truncates before the gates do -->
          <td class="w-full max-w-0 px-4 py-2.5">
            <div class="flex items-center gap-2">
              <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ row.pr.taskRef }}</span>
              <StatusBadge
                :status="row.pr.taskStatus"
                size="xs"
              />
            </div>
            <div class="mt-0.5 truncate text-foreground">
              {{ row.pr.taskTitle }}
            </div>
          </td>
          <td class="px-2 py-2.5">
            <NuxtLink
              :to="row.pr.pr.url"
              target="_blank"
              class="font-mono text-xs whitespace-nowrap"
              @click.stop
            >
              #{{ row.pr.pr.number }}
            </NuxtLink>
          </td>
          <td
            v-for="cell in row.cells"
            :key="cell.term"
            class="px-2 py-2.5"
          >
            <AppTooltip
              :text="cell.detail"
              :disabled="!cell.detail"
            >
              <AppBadge
                :label="cell.label"
                :color="cell.color"
                variant="subtle"
                size="sm"
                class="whitespace-nowrap"
              />
            </AppTooltip>
          </td>
          <td class="min-w-56 px-4 py-2.5">
            <PullRequestMerge :row="row" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
