<script setup lang="ts">
import { isWorking, ROLE } from '~/utils/labels'

// Placeholder for the mobile Agents tab (design/mobile.md); its real
// screen comes in a later task
const state = useLive().state
useSeoMeta({ title: 'Agents · Corral' })
</script>

<template>
  <UDashboardPanel>
    <div class="flex flex-col gap-2 p-4">
      <UButton
        v-for="agent in state.agents"
        :key="agent.id"
        :to="`/agents/${agent.name.toLowerCase()}`"
        variant="outline"
        color="neutral"
        class="justify-start"
      >
        <AgentAvatar
          :name="agent.name"
          :working="isWorking(agent)"
          size="xs"
        />
        {{ agent.name }} <span class="text-muted">· {{ ROLE[agent.role] }}</span>
        <span class="ms-auto text-xs text-muted">{{ isWorking(agent) ? 'Working' : agent.paused ? 'Paused' : 'Idle' }}</span>
      </UButton>
    </div>
  </UDashboardPanel>
</template>
