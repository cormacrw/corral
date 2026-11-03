<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed, resolveComponent, useSlots } from 'vue'
import { cn } from 'cn'
import { Button } from '~/components/ui/button'
import { buttonToneClass } from '~/lib/tone'
import type { ButtonAppearance, Tone } from '~/lib/tone'

// Every button in the product: a shadcn Button with icon, loading, tone and link
// handling in one place. Defaults to a compact solid primary button.
const props = withDefaults(defineProps<{
  label?: string
  icon?: string
  trailingIcon?: string
  color?: Tone
  variant?: ButtonAppearance
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  loading?: boolean
  disabled?: boolean
  block?: boolean
  square?: boolean
  to?: string | Record<string, unknown>
  target?: string
  type?: 'button' | 'submit' | 'reset'
  class?: HTMLAttributes['class']
}>(), { color: 'primary', variant: 'solid', size: 'md', type: 'button', label: undefined, icon: undefined, trailingIcon: undefined, to: undefined, target: undefined, class: undefined })

const slots = useSlots()
const iconOnly = computed(() => !props.label && !slots.default)
const SIZES = { xs: 'xs', sm: 'sm', md: 'sm', lg: 'default', xl: 'lg' } as const
const ICON_SIZES = { xs: 'icon-xs', sm: 'icon-sm', md: 'icon-sm', lg: 'icon', xl: 'icon-lg' } as const
const size = computed(() => (iconOnly.value || props.square ? ICON_SIZES : SIZES)[props.size])
const link = computed(() => props.to ? resolveComponent('NuxtLink') : undefined)
const inert = computed(() => props.disabled || props.loading)
</script>

<template>
  <Button
    :as="link ?? 'button'"
    :to="to"
    :target="target"
    :type="to ? undefined : type"
    variant="ghost"
    :size="size"
    :disabled="to ? undefined : inert"
    :aria-disabled="to && inert ? true : undefined"
    :aria-busy="loading || undefined"
    :class="cn(buttonToneClass(color, variant), block && 'w-full', to && inert && 'pointer-events-none opacity-50', props.class)"
  >
    <Icon
      v-if="loading"
      name="i-ri-loader-4-line"
      class="animate-spin motion-reduce:animate-none"
    />
    <Icon
      v-else-if="icon"
      :name="icon"
    />
    <slot name="leading" />
    <slot>{{ label }}</slot>
    <slot name="trailing" />
    <Icon
      v-if="trailingIcon"
      :name="trailingIcon"
    />
  </Button>
</template>
