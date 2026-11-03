<script setup lang="ts">
import { inboxTldr } from '~/features/inbox/utils/inbox-summary'

// The panel's opening lines: the item's message, or a TL;DR of its body
defineProps<{ item: { message?: string, body: string } }>()
</script>

<template>
  <InboxMessage
    v-if="item.message"
    :item="item"
    summary
  />
  <p
    v-else
    class="line-clamp-2 text-sm"
  >
    <span class="font-medium">TL;DR</span> <TaskRefText
      :text="inboxTldr(item.body)"
      class="text-muted-foreground"
    />
  </p>
</template>
