<script setup lang="ts" generic="Item extends string | Record<string, any>">
import type { HTMLAttributes } from 'vue'
import { computed, ref, inject } from 'vue'
import { cn } from 'cn'
import { FIELD_ID } from '~/lib/field'
import { Button } from '~/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '~/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'

// A searchable picker: shadcn's combobox recipe (Popover + Command) behind one
// component. `valueKey` picks the model's value out of object items.
defineOptions({ inheritAttrs: false })
const fieldId = inject(FIELD_ID, undefined)
const props = withDefaults(defineProps<{
  items: readonly Item[]
  valueKey?: string
  labelKey?: string
  searchInput?: boolean | { placeholder?: string }
  multiple?: boolean
  placeholder?: string
  icon?: string
  disabled?: boolean
  loading?: boolean
  size?: 'xs' | 'sm' | 'md' | 'lg'
  variant?: string
  // An inline field, as in a task's properties: plain text until hovered,
  // focused or open, when it shows its background and chevron
  inline?: boolean
  contentClass?: HTMLAttributes['class']
  class?: HTMLAttributes['class']
  // What the trigger reads, in place of the selected items' names
  label?: string
  labelTestid?: string
}>(), { valueKey: 'value', labelKey: 'label', searchInput: false, size: 'md', placeholder: undefined, icon: undefined, contentClass: undefined, class: undefined, variant: undefined, label: undefined, labelTestid: undefined })

type Value = unknown
const SIZES = { xs: 'h-6 text-xs', sm: 'h-7 text-xs', md: 'h-8', lg: 'h-9' }
const model = defineModel<Value>()
const open = ref(false)

const valueOf = (item: Item): Value => typeof item === 'object' ? (item as Record<string, unknown>)[props.valueKey] : item
const labelOf = (item: Item): string => String(typeof item === 'object' ? (item as Record<string, unknown>)[props.labelKey] : item)
const iconOf = (item: Item) => typeof item === 'object' ? (item as Record<string, string>).icon : undefined
const selected = computed(() => props.multiple ? (model.value as Value[] | undefined) ?? [] : [model.value])
const isSelected = (item: Item) => selected.value.includes(valueOf(item))
const selectedItems = computed(() => props.items.filter(isSelected))
const summary = computed(() => props.label ?? selectedItems.value.map(labelOf).join(', '))
const searchPlaceholder = computed(() => typeof props.searchInput === 'object' ? props.searchInput.placeholder : 'Search…')

function choose(item: Item) {
  const value = valueOf(item)
  if (!props.multiple) {
    model.value = value
    open.value = false
    return
  }
  const values = selected.value
  model.value = values.includes(value) ? values.filter(v => v !== value) : [...values, value]
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        v-bind="$attrs"
        :id="$attrs.id ?? fieldId"
        :variant="variant === 'ghost' || inline ? 'ghost' : 'outline'"
        size="sm"
        role="combobox"
        :aria-expanded="open"
        :disabled="disabled || loading"
        :class="cn('w-full justify-between font-normal', SIZES[size], inline && 'group/inline disabled:opacity-100', props.class)"
      >
        <slot
          name="leading"
          :model-value="model"
        >
          <Icon
            v-if="icon"
            :name="icon"
          />
        </slot>
        <span
          :class="['min-w-0 flex-1 truncate text-start', !summary && 'text-muted-foreground']"
          :data-testid="labelTestid"
        >{{ summary || placeholder }}</span>
        <Icon
          :name="loading ? 'i-hugeicons-loading-03' : 'i-hugeicons-arrow-down-01'"
          :class="['size-4 shrink-0 text-muted-foreground', loading && 'animate-spin motion-reduce:animate-none', inline && !loading && 'opacity-0 group-hover/inline:opacity-100 group-focus-visible/inline:opacity-100 group-aria-expanded/inline:opacity-100 group-disabled/inline:hidden']"
        />
      </Button>
    </PopoverTrigger>
    <PopoverContent
      align="start"
      :class="cn('w-(--reka-popover-trigger-width) min-w-48 p-0', contentClass)"
    >
      <slot name="content-top" />
      <Command>
        <CommandInput
          v-if="searchInput"
          :placeholder="searchPlaceholder"
        />
        <CommandList>
          <CommandEmpty>No results</CommandEmpty>
          <CommandGroup>
            <CommandItem
              v-for="item in items"
              :key="String(valueOf(item))"
              :value="labelOf(item)"
              @select="choose(item)"
            >
              <slot
                name="item-leading"
                :item="item"
              >
                <Icon
                  v-if="iconOf(item)"
                  :name="iconOf(item)!"
                />
              </slot>
              <span class="min-w-0 flex-1 truncate">{{ labelOf(item) }}</span>
              <Icon
                v-if="isSelected(item)"
                name="i-hugeicons-tick-02"
                class="ms-auto size-4"
              />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
