<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Card, CardContent, CardFooter, CardHeader } from '~/components/ui/card'

// `contentClass`: e.g. px-0 for rows that run edge to edge
defineProps<{ class?: HTMLAttributes['class'], contentClass?: HTMLAttributes['class'] }>()
</script>

<template>
  <Card :class="$props.class">
    <CardHeader v-if="$slots.header">
      <slot name="header" />
    </CardHeader>
    <CardContent :class="contentClass">
      <slot />
    </CardContent>
    <CardFooter v-if="$slots.footer">
      <slot name="footer" />
    </CardFooter>
  </Card>
</template>
