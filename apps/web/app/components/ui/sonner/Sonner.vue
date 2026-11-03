<script lang="ts" setup>
import type { ToasterProps } from 'vue-sonner'

import {
  RiCheckboxCircleLine,
  RiInformationLine,
  RiLoader4Line,
  RiCloseCircleLine,
  RiAlertLine,
  RiCloseLine,
} from '@remixicon/vue'
import { reactiveOmit } from '@vueuse/core'
import { cn } from 'cn'
import { Toaster as Sonner } from 'vue-sonner'

const props = defineProps<ToasterProps>()
const delegatedProps = reactiveOmit(props, 'class', 'toastOptions')
</script>

<template>
  <Sonner
    :class="cn('toaster group', props.class)"
    :style="{
      '--normal-bg': 'var(--popover)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
      '--gray2': 'hsl(var(--popover) / 0.9)',
      '--gray3': 'var(--border)',
      '--gray4': 'var(--border)',
      '--gray5': 'var(--border)',
      '--gray12': 'var(--popover-foreground)',
    }"
    :toast-options="props.toastOptions ?? {
      classes: {
        toast: 'rounded-2xl',
      },
    }"
    v-bind="delegatedProps"
  >
    <template #success-icon>
      <RiCheckboxCircleLine class="size-4" />
    </template>
    <template #info-icon>
      <RiInformationLine class="size-4" />
    </template>
    <template #warning-icon>
      <RiAlertLine class="size-4" />
    </template>
    <template #error-icon>
      <RiCloseCircleLine class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <RiLoader4Line class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <RiCloseLine class="size-4" />
    </template>
  </Sonner>
</template>
