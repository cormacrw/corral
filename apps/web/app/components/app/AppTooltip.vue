<script setup lang="ts">
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/components/ui/tooltip'

defineProps<{ text?: string, disabled?: boolean }>()
</script>

<template>
  <slot v-if="disabled || !text" />
  <TooltipProvider
    v-else
    :delay-duration="200"
  >
    <Tooltip>
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipContent>{{ text }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
