<script setup lang="ts">
import type { Agent, Epic } from '@corral/contracts'

// The Board's Epics view (design/board.md): the columns of epic cards
defineProps<{
  columns: { key: string, label: string, hint: string, dot: string, cards: { epic: Epic, waitingOn: Epic[], workingAgents: Agent[] }[] }[]
}>()
</script>

<template>
  <div
    role="region"
    aria-label="Board columns"
    tabindex="0"
    class="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto overscroll-x-contain p-4"
  >
    <section
      v-for="column in columns"
      :key="column.key"
      :aria-label="`${column.label}, ${column.cards.length}`"
      class="flex max-h-full w-[272px] shrink-0 flex-col rounded-lg border border-default bg-muted"
    >
      <BoardColumnHeader
        :label="column.label"
        :hint="column.hint"
        :count="column.cards.length"
        :dot="column.dot"
      />
      <div class="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
        <BoardEpicCard
          v-for="card in column.cards"
          :key="card.epic.id"
          :epic="card.epic"
          :waiting-on="card.waitingOn"
          :working-agents="card.workingAgents"
        />
        <p
          v-if="column.cards.length === 0"
          class="px-1 pb-2 text-xs text-dimmed"
        >
          Nothing here
        </p>
      </div>
    </section>
  </div>
</template>
