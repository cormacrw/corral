<script setup lang="ts">
import { isWorking, ROLE } from '~/utils/labels'

// The Agents tab (design/mobile.md). The web keeps its simple list for now.
const device = useDevice()
const state = useLive().state
useSeoMeta({ title: 'Agents · Corral' })
</script>

<template>
  <UDashboardPanel>
    <MobileAgents v-if="device.isMobile.value" />
    <div
      v-else
      class="flex flex-col gap-2 p-4"
    >
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
