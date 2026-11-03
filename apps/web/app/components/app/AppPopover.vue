<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'

defineProps<{ content?: { align?: 'start' | 'center' | 'end', side?: 'top' | 'right' | 'bottom' | 'left', collisionPadding?: number }, contentClass?: HTMLAttributes['class'] }>()
const open = defineModel<boolean>('open')
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverContent
      :align="content?.align"
      :side="content?.side"
      :collision-padding="content?.collisionPadding"
      :class="contentClass"
    >
      <slot name="content" />
    </PopoverContent>
  </Popover>
</template>
