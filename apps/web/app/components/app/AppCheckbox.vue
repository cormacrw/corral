<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { useId } from 'vue'
import { cn } from 'cn'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ label?: string, disabled?: boolean, class?: HTMLAttributes['class'] }>()
const model = defineModel<boolean | 'indeterminate'>({ default: false })
const id = useId()
</script>

<template>
  <div :class="cn('flex items-center gap-2', props.class)">
    <Checkbox
      :id="id"
      v-bind="$attrs"
      v-model="model"
      :disabled="disabled"
    />
    <Label
      v-if="label"
      :for="id"
    >{{ label }}</Label>
  </div>
</template>
