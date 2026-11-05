<script setup lang="ts">
import type { Agent, Project, Run } from '@corral/contracts'
import { elapsed, liveRunTitle } from '~/features/home/utils/dashboard'
import { agentStatus, isLiveRun, ROLE, runtimeLabel } from '~/utils/labels'

// The agents with live runs, and what each run is on. Agents that are paused
// or waiting out a usage limit are listed too, since they hold work back.
const props = defineProps<{ agents: Agent[], runs: Run[], projects: (Project & { color: string })[], now: number }>()

const rows = computed(() => props.agents
  .map(agent => ({
    agent,
    status: agentStatus(agent, props.now, false),
    runs: props.runs.filter(r => r.agentId === agent.id && isLiveRun(r))
  }))
  .filter(row => row.runs.length || row.status))
const projectOf = (id: string | null) => props.projects.find(p => p.id === id)
</script>

<template>
  <ul
    v-if="rows.length"
    class="-mx-2 flex flex-col"
  >
    <li
      v-for="{ agent, status, runs: live } in rows"
      :key="agent.id"
      class="relative flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted"
    >
      <AgentAvatar
        :name="agent.name"
        :working="live.length > 0"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2 text-sm">
          <span class="font-medium">{{ agent.name }}</span>
          <span class="text-xs text-muted-foreground">{{ ROLE[agent.role] }} · {{ runtimeLabel(agent.runtime) }}</span>
          <AppBadge
            v-if="status"
            :label="status.label"
            color="warning"
            variant="soft"
            size="sm"
            class="ms-auto"
          />
        </div>
        <p
          v-for="run in live"
          :key="run.id"
          class="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            v-if="projectOf(run.projectId)"
            class="size-1.5 shrink-0 rounded-full"
            :style="{ background: projectOf(run.projectId)!.color }"
            aria-hidden="true"
          />
          <TaskLink
            v-if="run.taskRef"
            :task-ref="run.taskRef"
            class="relative z-10 shrink-0 font-mono"
          />
          <span class="truncate">{{ liveRunTitle(run, null) }}</span>
          <span class="ms-auto shrink-0 tabular-nums">{{ elapsed(run.startedAt ?? run.queuedAt, now) }}</span>
        </p>
      </div>
      <NuxtLink
        :to="`/agents/${agent.name.toLowerCase()}`"
        :aria-label="agent.name"
        class="absolute inset-0 rounded-lg"
      />
    </li>
  </ul>
  <p
    v-else
    class="text-sm text-muted-foreground"
  >
    No agent is working right now.
  </p>
</template>
