<script setup lang="ts">
import { filterLabel } from '~/features/board/utils/board'

// One of the Board's filters (design/board.md): a multi-select dropdown, with
// "All …" at the top to clear the selection. An empty selection means all.
const props = defineProps<{
  items: { value: string, label: string }[]
  // "Parent": the aria label; the trigger reads "All parents" or "N parents"
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
  <AppSelectMenu
    v-model="selected"
    :items="props.items"
    multiple
    :label="label"
    :label-testid="`${props.name.toLowerCase()}-filter-label`"
    :aria-label="props.name"
    content-class="min-w-56"
  >
    <template #leading>
      <Icon
        :name="props.icon"
        class="size-4 text-muted-foreground"
      />
    </template>
    <template #content-top>
      <div class="border-b border-border p-1">
        <button
          type="button"
          :aria-pressed="selected.length === 0"
          :class="['flex w-full items-center gap-1.5 rounded-md p-1.5 text-start hover:bg-muted/50', props.size === 'sm' || props.size === 'xs' ? 'text-xs' : 'text-sm']"
          @click="selected = []"
        >
          <span class="flex-1">{{ all }}</span>
          <Icon
            v-if="selected.length === 0"
            name="i-ri-check-line"
            class="size-4 shrink-0"
          />
        </button>
      </div>
    </template>
  </AppSelectMenu>
</template>
