<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from 'cn'

// A titled card for one tile of a dashboard (Home, Agents)
const props = defineProps<{ title?: string, subtitle?: string, class?: HTMLAttributes['class'], bodyClass?: HTMLAttributes['class'] }>()
</script>

<template>
  <section :class="cn('flex min-w-0 flex-col rounded-xl border bg-card text-card-foreground', props.class)">
    <header
      v-if="title || $slots.actions"
      class="flex items-start justify-between gap-3 px-4 pt-4"
    >
      <div class="min-w-0">
        <h3 class="truncate text-sm font-medium">
          {{ title }}
        </h3>
        <p
          v-if="subtitle"
          class="truncate text-xs text-muted-foreground"
        >
          {{ subtitle }}
        </p>
      </div>
      <slot name="actions" />
    </header>
    <div :class="cn('flex min-h-0 flex-1 flex-col p-4', props.bodyClass)">
      <slot />
    </div>
  </section>
</template>
