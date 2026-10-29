<script setup lang="ts">
import { epicFilterLabel } from '~/utils/board'

// The Board's epic filter (design/board.md): a multi-select dropdown, with
// "All epics" at the top to clear the selection. An empty selection means
// all epics.
const props = defineProps<{
  epics: { id: string, label: string }[]
  size?: 'xs' | 'sm' | 'md'
}>()
const selected = defineModel<string[]>({ required: true })

const items = computed(() => props.epics.map(e => ({ label: e.label, value: e.id })))
const label = computed(() => epicFilterLabel(selected.value, id => props.epics.find(e => e.id === id)?.label ?? ''))
</script>

<template>
  <USelectMenu
    v-model="selected"
    :items="items"
    value-key="value"
    multiple
    :size="props.size"
    :search-input="false"
    aria-label="Epic"
    :ui="{ content: 'min-w-56' }"
  >
    <template #leading>
      <UIcon
        name="i-lucide-network"
        class="size-4 text-muted"
      />
    </template>
    <span
      class="truncate"
      data-testid="epic-filter-label"
    >{{ label }}</span>
    <template #content-top>
      <div class="border-b border-default p-1">
        <button
          type="button"
          :aria-pressed="selected.length === 0"
          :class="['flex w-full items-center gap-1.5 rounded-md p-1.5 text-start hover:bg-elevated/50', props.size === 'sm' || props.size === 'xs' ? 'text-xs' : 'text-sm']"
          @click="selected = []"
        >
          <span class="flex-1">All epics</span>
          <UIcon
            v-if="selected.length === 0"
            name="i-lucide-check"
            class="size-4 shrink-0"
          />
        </button>
      </div>
    </template>
  </USelectMenu>
</template>
