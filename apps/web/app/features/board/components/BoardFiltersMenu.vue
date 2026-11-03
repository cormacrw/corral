<script setup lang="ts">
import type { BoardFilters } from '~/features/board/utils/board'
import { activeFilterCount, boardFilterGroups, NO_FILTERS } from '~/features/board/utils/board'

// The web Board's Filters dropdown (design/board.md). Ticks stay a draft until
// Apply; closing the dropdown drops them. Reset takes effect at once. The search
// has its own control, so neither touches it.
const props = defineProps<{
  epics: { id: string, label: string }[]
  agents: { id: string, name: string }[]
}>()
const filters = defineModel<BoardFilters>({ required: true })

const open = ref(false)
const draft = ref<BoardFilters>({ ...filters.value })
watch(open, (isOpen) => {
  if (isOpen) draft.value = { ...filters.value }
})

const groups = computed(() => boardFilterGroups(props.epics, props.agents).filter(group => group.items.length > 0))
const activeCount = computed(() => activeFilterCount(filters.value))
const canReset = computed(() => activeCount.value + activeFilterCount(draft.value) > 0)

function toggle(key: 'epics' | 'statuses' | 'priorities' | 'agents', value: string, on: boolean | 'indeterminate') {
  const values: string[] = draft.value[key]
  draft.value = { ...draft.value, [key]: on === true ? [...values, value] : values.filter(v => v !== value) }
}

function apply() {
  filters.value = { ...draft.value, search: filters.value.search }
  open.value = false
}

function reset() {
  draft.value = { ...NO_FILTERS, search: filters.value.search }
  filters.value = draft.value
}
</script>

<template>
  <AppPopover
    v-model:open="open"
    :content="{ align: 'end' }"
    content-class="flex max-h-[min(36rem,calc(100vh-6rem))] w-[28rem] flex-col gap-3"
  >
    <AppButton
      icon="i-ri-filter-3-line"
      label="Filters"
      size="sm"
      variant="outline"
      color="neutral"
      :aria-label="activeCount ? `Filters, ${activeCount} active` : 'Filters'"
    >
      <template #trailing>
        <AppBadge
          v-if="activeCount"
          :label="activeCount"
          size="sm"
          data-testid="board-filter-count"
        />
      </template>
    </AppButton>
    <template #content>
      <div
        class="grid min-h-0 grid-cols-2 gap-x-4 gap-y-3 overflow-y-auto"
        data-testid="board-filters"
      >
        <fieldset
          v-for="group in groups"
          :key="group.key"
          class="flex min-w-0 flex-col gap-1.5"
        >
          <legend class="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Icon
              :name="group.icon"
              class="size-4"
            />
            {{ group.name }}
          </legend>
          <AppCheckbox
            v-for="item in group.items"
            :key="item.value"
            :label="item.label"
            :model-value="(draft[group.key] as string[]).includes(item.value)"
            @update:model-value="toggle(group.key, item.value, $event)"
          />
        </fieldset>
      </div>
      <div class="flex shrink-0 justify-end gap-2">
        <AppButton
          label="Reset"
          size="sm"
          variant="ghost"
          color="neutral"
          :disabled="!canReset"
          @click="reset"
        />
        <AppButton
          label="Apply"
          size="sm"
          @click="apply"
        />
      </div>
    </template>
  </AppPopover>
</template>
