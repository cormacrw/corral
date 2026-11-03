<script setup lang="ts">
import { useNow } from '~/composables/useNow'
import { timeAgo } from '~/utils/labels'

// A relative time that keeps itself current, on its own, so the page around it
// doesn't re-render as time passes
defineProps<{ at: string | null | undefined }>()
const now = useNow()
</script>

<template>
  {{ timeAgo(at, now) }}
</template>
