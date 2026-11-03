<script lang="ts" setup>
import type { ToasterProps } from 'vue-sonner'

import { HugeiconsIcon } from '@hugeicons/vue'
import { Alert02Icon, Cancel01Icon, CancelCircleIcon, CheckmarkCircle02Icon, InformationCircleIcon, Loading03Icon } from '@hugeicons/core-free-icons'
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
      <HugeiconsIcon :icon="CheckmarkCircle02Icon" :stroke-width="2" class="size-4" />
    </template>
    <template #info-icon>
      <HugeiconsIcon :icon="InformationCircleIcon" :stroke-width="2" class="size-4" />
    </template>
    <template #warning-icon>
      <HugeiconsIcon :icon="Alert02Icon" :stroke-width="2" class="size-4" />
    </template>
    <template #error-icon>
      <HugeiconsIcon :icon="CancelCircleIcon" :stroke-width="2" class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <HugeiconsIcon :icon="Loading03Icon" :stroke-width="2" class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <HugeiconsIcon :icon="Cancel01Icon" :stroke-width="2" class="size-4" />
    </template>
  </Sonner>
</template>
