<script setup lang="ts">
import { useNow } from '~/composables/useNow'
import { duration } from '~/utils/labels'

// How long something has been running, kept current as TimeAgo is
defineProps<{ from: string | null }>()
const now = useNow()
</script>

<template>
  {{ duration(from, null, now) }}
</template>
