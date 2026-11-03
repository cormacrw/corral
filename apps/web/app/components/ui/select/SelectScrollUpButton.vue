<script setup lang="ts">
import type { SelectScrollUpButtonProps } from 'reka-ui'

import type { HTMLAttributes } from 'vue'
import { HugeiconsIcon } from '@hugeicons/vue'
import { ArrowUp01Icon } from '@hugeicons/core-free-icons'
import { reactiveOmit } from '@vueuse/core'
import { cn } from 'cn'
import { SelectScrollUpButton, useForwardProps } from 'reka-ui'

const props = defineProps<SelectScrollUpButtonProps & { class?: HTMLAttributes['class'] }>()

const delegatedProps = reactiveOmit(props, 'class')

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <SelectScrollUpButton
    data-slot="select-scroll-up-button"
    v-bind="forwardedProps"
    :class="cn('bg-popover z-10 flex cursor-default items-center justify-center py-1 [&_svg:not([class*=size-])]:size-4', props.class)"
  >
    <slot>
      <HugeiconsIcon :icon="ArrowUp01Icon" :stroke-width="2" />
    </slot>
  </SelectScrollUpButton>
</template>
