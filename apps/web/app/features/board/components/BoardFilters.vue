<script setup lang="ts">
import type { BoardFilters } from '~/features/board/utils/board'
import { boardFilterGroups } from '~/features/board/utils/board'

// The mobile Board's filters (design/board.md): Task with subtasks, Status, Priority and
// Agent multi-selects
const props = defineProps<{
  epics: { id: string, label: string }[]
  agents: { id: string, name: string }[]
  itemClass?: string
}>()
const filters = defineModel<BoardFilters>({ required: true })

const groups = computed(() => boardFilterGroups(props.epics, props.agents))
</script>

<template>
  <BoardFilter
    v-for="group in groups"
    :key="group.key"
    :model-value="filters[group.key]"
    :items="[...group.items]"
    :name="group.name"
    :plural="group.plural"
    :icon="group.icon"
    :class="props.itemClass"
    @update:model-value="filters = { ...filters, [group.key]: $event }"
  />
</template>
