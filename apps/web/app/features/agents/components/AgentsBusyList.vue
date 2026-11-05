<script setup lang="ts">
import type { Agent } from '@corral/contracts'
import { ROLE, runtimeLabel } from '~/utils/labels'

// Every agent, its status and the share of the last hours it spent running
defineProps<{
  agents: { agent: Agent, working: boolean, status: { label: string } | null, busy: number, runsToday: number }[]
  hours: number
}>()
</script>

<template>
  <ul
    v-if="agents.length"
    class="-mx-2 flex flex-col"
  >
    <li
      v-for="{ agent, working, status, busy, runsToday } in agents"
      :key="agent.id"
    >
      <NuxtLink
        :to="`/agents/${agent.name.toLowerCase()}`"
        class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted"
      >
        <AgentAvatar
          :name="agent.name"
          :working="working"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2 text-sm">
            <span class="font-medium">{{ agent.name }}</span>
            <span class="truncate text-xs text-muted-foreground">{{ ROLE[agent.role] }} · {{ runtimeLabel(agent.runtime) }}</span>
            <span
              v-if="status"
              class="ms-auto shrink-0 text-xs text-muted-foreground"
            >{{ status.label }}</span>
          </div>
          <div class="mt-1.5 flex items-center gap-2">
            <AppTooltip :text="`Running ${Math.round(busy * 100)}% of the last ${hours} hours`">
              <div class="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  class="h-full rounded-full bg-chart-3"
                  :style="{ width: `${busy * 100}%` }"
                />
              </div>
            </AppTooltip>
            <span class="w-20 shrink-0 text-end text-xs text-muted-foreground tabular-nums">{{ runsToday }} {{ runsToday === 1 ? 'run' : 'runs' }} today</span>
          </div>
        </div>
      </NuxtLink>
    </li>
  </ul>
  <p
    v-else
    class="text-sm text-muted-foreground"
  >
    No agents yet.
  </p>
</template>
