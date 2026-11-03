<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { inject } from 'vue'
import { cn } from 'cn'
import { FIELD_ID } from '~/lib/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'

export type SelectOption = string | { label: string, value: string, disabled?: boolean }

defineOptions({ inheritAttrs: false })
const fieldId = inject(FIELD_ID, undefined)
const props = defineProps<{ items: readonly SelectOption[], placeholder?: string, disabled?: boolean, class?: HTMLAttributes['class'] }>()
const model = defineModel<string>()
const option = (item: SelectOption) => typeof item === 'string' ? { label: item, value: item } : item
</script>

<template>
  <Select
    v-model="model"
    :disabled="disabled"
  >
    <SelectTrigger
      v-bind="$attrs"
      :id="$attrs.id ?? fieldId"
      size="sm"
      :class="cn('w-full', props.class)"
    >
      <SelectValue :placeholder="placeholder" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem
        v-for="item in items.map(option)"
        :key="item.value"
        :value="item.value"
        :disabled="item.disabled"
      >
        {{ item.label }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
