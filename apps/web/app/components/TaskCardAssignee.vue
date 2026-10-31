<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { cardAssignee } from '~/utils/board'

// A Board card's assignee: an avatar only, with the name on hover, or a dashed
// circle when the role whose turn it is has no agent yet. The green dot means
// this agent holds the lease, not just that someone is working on the task.
const props = defineProps<{ task: Task }>()
const agent = computed(() => cardAssignee(props.task))
const working = computed(() => Boolean(agent.value && props.task.lease?.agentId === agent.value.id))
</script>

<template>
  <UTooltip :text="agent?.name ?? 'Unassigned'">
    <span
      role="img"
      :aria-label="agent ? (working ? `${agent.name}, working` : agent.name) : 'Unassigned'"
      class="inline-flex shrink-0"
    >
      <AgentAvatar
        v-if="agent"
        :name="agent.name"
        :working="working"
        size="xs"
      />
      <span
        v-else
        class="size-6 rounded-full border border-dashed border-accented"
        data-testid="card-unassigned"
      />
    </span>
  </UTooltip>
</template>
