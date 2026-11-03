<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from 'cn'
import { Badge } from '~/components/ui/badge'
import { TONE_CLASSES } from '~/lib/tone'
import type { Appearance, Tone } from '~/lib/tone'

const props = withDefaults(defineProps<{
  label?: string | number
  icon?: string
  color?: Tone
  variant?: Appearance
  size?: 'xs' | 'sm' | 'md' | 'lg'
  class?: HTMLAttributes['class']
}>(), { color: 'primary', variant: 'solid', size: 'md', label: undefined, icon: undefined, class: undefined })

const SIZES = { xs: 'h-4 px-1 text-[10px]', sm: 'h-5 px-1.5 text-xs', md: 'h-5 px-2 text-xs', lg: 'h-6 px-2 text-sm' }
</script>

<template>
  <Badge
    variant="outline"
    :class="cn('border-transparent', TONE_CLASSES[color][variant], SIZES[size], props.class)"
  >
    <Icon
      v-if="icon"
      :name="icon"
    />
    <slot>{{ label }}</slot>
  </Badge>
</template>
