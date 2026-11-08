<script setup lang="ts">
import { ROLE_LABELS } from '@corral/core'
import { agentPath } from '~/utils/routes'
import type { Agent, Project } from '@corral/contracts'
import { projectColor } from '~/utils/labels'

defineProps<{
  agents: {
    agent: Agent
    working: boolean
    status?: string
    lines: { id: string, ref: string | null, taskRef: string | null, title: string, project?: Project, detail: string }[]
  }[]
  loaded: boolean
}>()
</script>

<template>
  <section class="flex flex-col gap-2">
    <h2 class="text-sm font-semibold text-foreground">
      Agents
    </h2>
    <ul class="flex flex-col gap-2">
      <li
        v-for="{ agent, lines, working, status } in agents"
        :key="agent.id"
      >
        <!-- The agent link covers the card, so task links can sit beside it, not inside it -->
        <div
          :class="['relative flex flex-col gap-2 rounded-lg border p-3', working ? 'border-primary/60 ring-2 ring-primary/15' : 'border-border']"
          :data-testid="`home-agent-${agent.name.toLowerCase()}`"
        >
          <div class="flex items-center gap-2">
            <AgentAvatar
              :name="agent.name"
              :working="working"
            />
            <span class="font-semibold text-foreground">{{ agent.name }}</span>
            <span class="text-sm text-muted-foreground">{{ ROLE_LABELS[agent.role] }}</span>
            <span
              v-if="status"
              class="ms-auto text-xs text-muted-foreground"
            >{{ status }}</span>
          </div>
          <div
            v-for="line in lines"
            :key="line.id"
            class="ps-10"
          >
            <p class="truncate">
              <TaskLink
                v-if="line.taskRef"
                :task-ref="line.taskRef"
                class="relative z-10 me-1 font-mono text-xs"
              />
              <span
                v-else-if="line.ref"
                class="me-1 font-mono text-xs text-muted-foreground"
              >{{ line.ref }}</span>
              <span class="font-medium text-foreground">{{ line.title }}</span>
            </p>
            <p class="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <span
                v-if="line.project"
                class="size-2 shrink-0 rounded-full"
                :style="{ background: projectColor(line.project) }"
                aria-hidden="true"
              />
              {{ line.detail }}
            </p>
          </div>
          <NuxtLink
            :to="agentPath(agent.name)"
            :aria-label="agent.name"
            class="absolute inset-0 rounded-lg"
          />
        </div>
      </li>
    </ul>
    <p
      v-if="loaded && agents.length === 0"
      class="text-sm text-muted-foreground"
    >
      No agents yet.
    </p>
  </section>
</template>
