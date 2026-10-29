<script setup lang="ts">
import { filterLabel } from '~/utils/board'

// One of the Board's filters (design/board.md): a multi-select dropdown, with
// "All …" at the top to clear the selection. An empty selection means all.
const props = defineProps<{
  items: { value: string, label: string }[]
  // "Epic": the aria label; the trigger reads "All epics" or "N epics"
  name: string
  plural: string
  icon: string
  size?: 'xs' | 'sm' | 'md'
}>()
const selected = defineModel<string[]>({ required: true })

const all = computed(() => `All ${props.plural}`)
const label = computed(() => filterLabel(selected.value, id => props.items.find(i => i.value === id)?.label ?? '', all.value, props.plural))
</script>

<template>
  <USelectMenu
    v-model="selected"
    :items="props.items"
    value-key="value"
    multiple
    :size="props.size"
    :search-input="false"
    :aria-label="props.name"
    :ui="{ content: 'min-w-56' }"
  >
    <template #leading>
      <UIcon
        :name="props.icon"
        class="size-4 text-muted"
      />
    </template>
    <span
      class="truncate"
      :data-testid="`${props.name.toLowerCase()}-filter-label`"
    >{{ label }}</span>
    <template #content-top>
      <div class="border-b border-default p-1">
        <button
          type="button"
          :aria-pressed="selected.length === 0"
          :class="['flex w-full items-center gap-1.5 rounded-md p-1.5 text-start hover:bg-elevated/50', props.size === 'sm' || props.size === 'xs' ? 'text-xs' : 'text-sm']"
          @click="selected = []"
        >
          <span class="flex-1">{{ all }}</span>
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
