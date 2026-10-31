<script setup lang="ts">
import { useInboxView } from '~/composables/useInboxView'

// The Inbox's detail pane with no item to show
const { inbox, count } = useInboxView()
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
    <template v-if="inbox && count === 0">
      <UIcon
        name="i-lucide-circle-check"
        class="size-8 text-success"
      />
      <span class="font-medium text-default">All clear</span>
      <span>Nothing needs you right now.</span>
    </template>
    <span v-else>Pick an item.</span>
  </div>
</template>
