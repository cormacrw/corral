<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { useId } from 'vue'
import { cn } from 'cn'
import { Label } from '~/components/ui/label'
import { Switch } from '~/components/ui/switch'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ label?: string, disabled?: boolean, class?: HTMLAttributes['class'], labelClass?: HTMLAttributes['class'], switchClass?: HTMLAttributes['class'] }>()
const model = defineModel<boolean>({ default: false })
const id = useId()
</script>

<template>
  <div :class="cn('flex items-center gap-2', props.class)">
    <Switch
      :id="id"
      v-bind="$attrs"
      v-model="model"
      :disabled="disabled"
      :class="switchClass"
    />
    <Label
      v-if="label"
      :for="id"
      :class="labelClass"
    >{{ label }}</Label>
  </div>
</template>
