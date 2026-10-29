<script setup lang="ts">
import type { BoardFilters } from '~/utils/board'
import { BOARD_COLUMNS, hasFilters, NO_FILTERS } from '~/utils/board'
import { PRIORITY } from '~/utils/labels'

// The Board's filter row (design/board.md), on the web and mobile Boards:
// Epic, Status, Priority and Agent multi-selects, and Clear filters while
// anything (search included) is filtered.
const props = defineProps<{
  epics: { id: string, label: string }[]
  agents: { id: string, name: string }[]
  size?: 'xs' | 'sm' | 'md'
  // Classes for each dropdown
  itemClass?: string
}>()
const filters = defineModel<BoardFilters>({ required: true })

const epicItems = computed(() => props.epics.map(e => ({ value: e.id, label: e.label })))
const statusItems = BOARD_COLUMNS.map(c => ({ value: c.key, label: c.label }))
const priorityItems = Object.entries(PRIORITY).map(([value, p]) => ({ value, label: p.label }))
const agentItems = computed(() => props.agents.map(a => ({ value: a.id, label: a.name })))

function set<K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) {
  filters.value = { ...filters.value, [key]: value }
}
</script>

<template>
  <BoardFilter
    :model-value="filters.epics"
    :items="epicItems"
    name="Epic"
    plural="epics"
    icon="i-lucide-network"
    :size="props.size"
    :class="props.itemClass"
    @update:model-value="set('epics', $event)"
  />
  <BoardFilter
    :model-value="filters.statuses"
    :items="statusItems"
    name="Status"
    plural="statuses"
    icon="i-lucide-columns-3"
    :size="props.size"
    :class="props.itemClass"
    @update:model-value="set('statuses', $event)"
  />
  <BoardFilter
    :model-value="filters.priorities"
    :items="priorityItems"
    name="Priority"
    plural="priorities"
    icon="i-lucide-signal"
    :size="props.size"
    :class="props.itemClass"
    @update:model-value="set('priorities', $event as BoardFilters['priorities'])"
  />
  <BoardFilter
    :model-value="filters.agents"
    :items="agentItems"
    name="Agent"
    plural="agents"
    icon="i-lucide-bot"
    :size="props.size"
    :class="props.itemClass"
    @update:model-value="set('agents', $event)"
  />
  <UButton
    v-if="hasFilters(filters)"
    label="Clear filters"
    icon="i-lucide-x"
    :size="props.size === 'sm' ? 'xs' : 'sm'"
    variant="ghost"
    color="neutral"
    class="shrink-0"
    @click="filters = { ...NO_FILTERS }"
  />
</template>
