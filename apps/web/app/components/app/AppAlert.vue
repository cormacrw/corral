<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from 'cn'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { TONE_CLASSES } from '~/lib/tone'
import type { Appearance, ButtonAppearance, Tone } from '~/lib/tone'

interface AlertAction {
  label: string
  color?: Tone
  variant?: ButtonAppearance
  icon?: string
  loading?: boolean
  disabled?: boolean
  to?: string
  target?: string
  trailingIcon?: string
  onClick?: () => unknown
}

const props = withDefaults(defineProps<{
  title?: string
  description?: string
  icon?: string
  color?: Tone
  variant?: Appearance
  actions?: AlertAction[]
  orientation?: 'horizontal' | 'vertical'
  class?: HTMLAttributes['class']
}>(), { color: 'neutral', variant: 'subtle', orientation: 'vertical', title: undefined, description: undefined, icon: undefined, actions: () => [], class: undefined })
</script>

<template>
  <!-- Nuxt Icon can render a span, not an svg, so the stock has-[>svg]
       grid misses it: the icon column is set here instead -->
  <Alert :class="cn(TONE_CLASSES[color][variant], icon && 'grid-cols-[auto_1fr] gap-x-2', props.class)">
    <Icon
      v-if="icon"
      :name="icon"
      class="row-span-2 size-4 translate-y-0.5"
    />
    <div :class="[icon ? 'col-start-2' : 'col-start-[-1]', 'flex min-w-0 gap-2', orientation === 'horizontal' ? 'items-center justify-between' : 'flex-col']">
      <div class="min-w-0">
        <AlertTitle v-if="title">
          {{ title }}
        </AlertTitle>
        <AlertDescription
          v-if="description || $slots.description"
          class="text-current/80"
        >
          <slot name="description">
            {{ description }}
          </slot>
        </AlertDescription>
      </div>
      <div
        v-if="actions.length"
        class="flex shrink-0 flex-wrap gap-1.5"
      >
        <AppButton
          v-for="action in actions"
          :key="action.label"
          size="xs"
          :color="action.color ?? color"
          :variant="action.variant ?? 'outline'"
          :label="action.label"
          :icon="action.icon"
          :loading="action.loading"
          :disabled="action.disabled"
          :to="action.to"
          :target="action.target"
          :trailing-icon="action.trailingIcon"
          @click="action.onClick?.()"
        />
      </div>
    </div>
  </Alert>
</template>
