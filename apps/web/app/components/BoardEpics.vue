<script setup lang="ts">
import type { Epic } from '@corral/contracts'

// The Board's epics, above the columns: progress, review mode and epic PR
defineProps<{ epics: Epic[] }>()
</script>

<template>
  <ul
    aria-label="Epics"
    data-testid="board-epics"
    class="flex shrink-0 gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
  >
    <li
      v-for="epic in epics"
      :key="epic.id"
      class="w-[272px] shrink-0 rounded-md border border-default bg-default p-3 max-sm:w-[260px]"
    >
      <EpicProgressRow
        :id="epic.id"
        :title="epic.title"
        :merged="epic.mergedCount"
        :total="epic.taskCount"
        :epic="epic"
      />
    </li>
  </ul>
</template>
