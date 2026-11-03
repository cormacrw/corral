<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { NumberField, NumberFieldContent, NumberFieldDecrement, NumberFieldIncrement, NumberFieldInput } from '~/components/ui/number-field'

defineOptions({ inheritAttrs: false })
defineProps<{ min?: number, max?: number, step?: number, placeholder?: string, class?: HTMLAttributes['class'] }>()
const model = defineModel<number | null>()
</script>

<template>
  <NumberField
    :model-value="model ?? undefined"
    :min="min"
    :max="max"
    :step="step"
    :class="$props.class"
    @update:model-value="model = Number.isNaN($event) ? null : $event"
  >
    <NumberFieldContent>
      <NumberFieldDecrement />
      <NumberFieldInput
        v-bind="$attrs"
        :placeholder="placeholder"
      />
      <NumberFieldIncrement />
    </NumberFieldContent>
  </NumberField>
</template>
