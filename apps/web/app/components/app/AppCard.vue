<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Card, CardContent, CardFooter, CardHeader } from '~/components/ui/card'

defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <Card :class="$props.class">
    <CardHeader v-if="$slots.header">
      <slot name="header" />
    </CardHeader>
    <CardContent>
      <slot />
    </CardContent>
    <CardFooter v-if="$slots.footer">
      <slot name="footer" />
    </CardFooter>
  </Card>
</template>
