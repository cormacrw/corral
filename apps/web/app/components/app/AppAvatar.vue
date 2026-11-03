<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from 'cn'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'

const props = withDefaults(defineProps<{ text?: string, src?: string, alt?: string, size?: '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '3xl', class?: HTMLAttributes['class'] }>(), { size: 'md', text: undefined, src: undefined, alt: undefined, class: undefined })
const SIZES = { '2xs': 'size-5 text-[10px]', 'xs': 'size-6 text-xs', 'sm': 'size-7 text-xs', 'md': 'size-8 text-sm', 'lg': 'size-10 text-base', 'xl': 'size-12 text-lg', '3xl': 'size-16 text-xl' }
</script>

<template>
  <Avatar :class="cn(SIZES[size], props.class)">
    <AvatarImage
      v-if="src"
      :src="src"
      :alt="alt ?? ''"
    />
    <AvatarFallback class="text-inherit">
      {{ text }}
    </AvatarFallback>
  </Avatar>
</template>
