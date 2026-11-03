<script setup lang="ts">
import { computed } from 'vue'
import type { Task } from '@corral/contracts'
import { agentHolds } from '~/features/tasks/utils/taskDetail'

// Who's working on the task right now, on the mobile screen (design/mobile.md)
const props = defineProps<{ task: Task }>()
const shell = useShell()
const agent = computed(() => agentHolds(props.task) && props.task.lease ? shell.agents.find(a => a.id === props.task.lease!.agentId) ?? null : null)
</script>

<template>
  <div
    v-if="agent"
    class="-mt-2 flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm"
  >
    <AgentAvatar
      :name="agent.name"
      size="xs"
      working
    />
    <span class="min-w-0 flex-1 truncate"><span class="font-medium">{{ agent.name }}</span> <span class="text-muted-foreground">is working</span></span>
    <NuxtLink
      :to="`/agents/${agent.name.toLowerCase()}/${task.lease?.runId}`"
      class="font-medium text-brand"
    >Watch</NuxtLink>
  </div>
</template>
