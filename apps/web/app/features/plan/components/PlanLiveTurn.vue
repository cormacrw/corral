<script setup lang="ts">
import type { RunEvent } from '@corral/contracts'

// The PM's turn in progress, at the end of the log
defineProps<{ events: RunEvent[], pmName: string, working: string }>()
</script>

<template>
  <div class="flex max-w-full min-w-0 gap-2">
    <AgentAvatar
      :name="pmName"
      size="sm"
    />
    <div class="flex min-w-0 flex-1 flex-col gap-2">
      <span class="text-xs text-muted-foreground">{{ pmName }} · PM</span>
      <RunTranscript
        :events="events"
        live
        :agent-name="pmName"
        :working="working"
        inline
      />
    </div>
  </div>
</template>
