<script setup lang="ts">
import { inject, onMounted, useTemplateRef } from 'vue'
import { FIELD_ID } from '~/lib/field'
import type { HTMLAttributes } from 'vue'
import { cn } from 'cn'
import { Textarea } from '~/components/ui/textarea'

defineOptions({ inheritAttrs: false })
const fieldId = inject(FIELD_ID, undefined)
const props = defineProps<{ autoresize?: boolean, autofocus?: boolean, variant?: 'outline' | 'ghost' | 'none', class?: HTMLAttributes['class'] }>()
const model = defineModel<string | null>()
const field = useTemplateRef<{ $el: HTMLTextAreaElement }>('field')
// The native attribute does nothing on an element added after page load
onMounted(() => {
  if (props.autofocus) field.value?.$el.focus()
})
</script>

<template>
  <Textarea
    v-bind="$attrs"
    :id="$attrs.id ?? fieldId"
    ref="field"
    :model-value="model ?? ''"
    :class="cn(autoresize ? 'field-sizing-content' : 'resize-y', variant && variant !== 'outline' && 'border-transparent bg-transparent shadow-none dark:bg-transparent', props.class)"
    @update:model-value="model = String($event)"
  />
</template>
