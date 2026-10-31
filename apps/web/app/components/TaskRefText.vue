<script setup lang="ts">
import { useTaskRefText } from '~/composables/useTaskRefText'

const props = defineProps<{ text: string }>()
const textNode = useTaskRefText()
const Rendered = () => textNode(props.text)
</script>

<template>
  <span><Rendered /></span>
</template>
