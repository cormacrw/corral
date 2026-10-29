<script setup lang="ts">
import { agentStatus, isWorking, ROLE } from '~/utils/labels'

// The Agents tab (design/mobile.md). The web keeps its simple list for now.
const now = ref(Date.now())
onMounted(() => {
  const timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  onBeforeUnmount(() => clearInterval(timer))
})
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
        <span
          v-if="agentStatus(agent, now)"
          class="ms-auto text-xs text-muted"
        >{{ agentStatus(agent, now)?.label }}</span>
      </UButton>
    </div>
  </UDashboardPanel>
</template>
