<script setup lang="ts">
import { inject, onMounted, useTemplateRef } from 'vue'
import { FIELD_ID } from '~/lib/field'
import type { HTMLAttributes } from 'vue'
import { cn } from 'cn'
import { Input } from '~/components/ui/input'

defineOptions({ inheritAttrs: false })
const fieldId = inject(FIELD_ID, undefined)
const props = withDefaults(defineProps<{
  icon?: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  variant?: 'outline' | 'soft' | 'ghost' | 'none'
  autofocus?: boolean
  class?: HTMLAttributes['class']
}>(), { size: 'md', icon: undefined, variant: undefined, class: undefined })
const model = defineModel<string | number | null>()

const SIZES = { xs: 'h-6 text-xs', sm: 'h-7 text-xs', md: 'h-8 text-sm', lg: 'h-9 text-sm', xl: 'h-10 text-base' }
const box = useTemplateRef<HTMLElement>('box')
const focus = () => box.value?.querySelector('input')?.focus()
defineExpose({ focus })
// The native attribute does nothing on an element added after page load
onMounted(() => {
  if (props.autofocus) focus()
})
</script>

<template>
  <div
    ref="box"
    :class="cn('relative inline-flex w-full items-center', props.class)"
  >
    <Icon
      v-if="icon"
      :name="icon"
      class="pointer-events-none absolute start-2 size-4 text-muted-foreground"
    />
    <Input
      v-bind="$attrs"
      :id="$attrs.id ?? fieldId"
      :model-value="model ?? ''"
      :class="cn(SIZES[size], icon && 'ps-8', variant === 'soft' ? 'border-transparent bg-muted shadow-none' : variant && variant !== 'outline' && 'border-transparent bg-transparent shadow-none dark:bg-transparent')"
      @update:model-value="model = $event"
    />
    <slot name="trailing" />
  </div>
</template>
