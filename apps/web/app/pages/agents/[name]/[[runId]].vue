<script setup lang="ts">
import { agentStatus, duration, isLiveRun as isLive, ROLE, runBadge, runTokens, runtimeLabel, timeAgo } from '~/utils/labels'

// An agent's page (design/agent.md): runs list and the transcript. Mobile
// shows the agent and its runs at /agents/:name, and a run's transcript
// at /agents/:name/:runId (design/mobile.md).
const route = useRoute()
const router = useRouter()
const flyout = useTaskFlyout()
const device = useDevice()
const view = useAgentRuns({ autoSelect: () => !device.isMobile.value })
const { name, agent, runs, error, events, now, selected, load, today, tiles, facts, stop, projectName, sent } = view
useSeoMeta({ title: () => `${agent.value?.name ?? 'Agent'} · Corral` })
</script>

<template>
  <UDashboardPanel
    v-if="device.isMobile.value"
    :ui="{ body: 'p-0' }"
  >
    <MobileAgentRun
      v-if="route.params.runId"
      :view="view"
    />
    <MobileAgent
      v-else
      :view="view"
    />
  </UDashboardPanel>
  <UDashboardPanel
    v-else
    :ui="{ body: 'p-0' }"
  >
    <div
      v-if="!agent"
      class="p-6"
    >
      <USkeleton class="h-8 w-48" />
    </div>
    <div
      v-else
      class="flex h-full min-h-0 flex-col"
    >
      <header class="flex items-center gap-3 border-b border-default px-4 py-3">
        <AgentAvatar
          :name="agent.name"
          :working="agent.activeRuns > 0"
          size="lg"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h1 class="text-lg font-semibold">
              {{ agent.name }}
            </h1>
            <UBadge
              v-if="agentStatus(agent, now)"
              v-bind="agentStatus(agent, now)"
              variant="subtle"
            />
          </div>
          <p class="text-sm text-muted">
            {{ ROLE[agent.role] }} · <span data-testid="agent-runtime-label">{{ runtimeLabel(agent.runtime) }}</span> · {{ today.length }} runs today
            <span v-if="agentStatus(agent, now)?.label === 'Waiting on usage limit'"> · Waiting on usage limit until {{ new Date(agent.pausedUntil!).toLocaleTimeString() }}</span>
          </p>
        </div>
        <UButton
          to="/settings/agents"
          label="Agent settings"
          variant="outline"
          color="neutral"
          size="sm"
        />
      </header>
      <div class="border-b border-default px-4 py-3">
        <div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
          <dl
            v-for="tile in tiles"
            :key="tile.label"
          >
            <dt class="text-xs text-muted">
              {{ tile.label }}
            </dt>
            <dd class="text-xl font-semibold tabular-nums">
              {{ tile.value }}
            </dd>
            <dd class="text-xs text-muted">
              {{ tile.sub }}
            </dd>
          </dl>
        </div>
        <p class="mt-2 text-xs text-muted">
          {{ facts }}
        </p>
      </div>

      <div class="flex min-h-0 flex-1">
        <div class="flex w-80 shrink-0 flex-col border-e border-default">
          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            :title="error"
            class="m-3"
            :actions="[{ label: 'Retry', onClick: load }]"
          />
          <ul class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <li
              v-for="run in runs"
              :key="run.id"
            >
              <button
                type="button"
                :aria-current="selected?.id === run.id ? 'true' : undefined"
                :class="['flex w-full flex-col gap-0.5 border-b border-default px-3 py-2 text-start text-sm', selected?.id === run.id && 'bg-elevated', isLive(run) && 'border-s-2 border-s-primary']"
                @click="router.push(`/agents/${name}/${run.id}`)"
              >
                <span class="flex items-center gap-2">
                  <span class="font-mono text-xs text-muted">{{ run.taskRef ?? 'Plan' }}</span>
                  <UBadge
                    :label="runBadge(run).label"
                    :color="runBadge(run).color"
                    variant="subtle"
                    size="xs"
                  />
                  <span class="ms-auto text-xs text-dimmed">{{ timeAgo(run.queuedAt, now) }}</span>
                </span>
                <span class="truncate">{{ run.taskTitle ?? run.summary ?? 'PM turn' }}</span>
                <span class="text-xs text-muted">{{ projectName(run) }} · Run #{{ run.number }} · {{ duration(run.startedAt, run.endedAt, now) }}</span>
              </button>
            </li>
            <li
              v-if="runs.length === 0"
              class="p-4 text-sm text-muted"
            >
              No runs yet.
            </li>
          </ul>
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
          <template v-if="selected">
            <!-- One line at the flyout header's height; long titles truncate -->
            <header class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4 text-sm">
              <span class="min-w-0 truncate font-medium">{{ selected.taskRef ?? 'Plan' }} {{ selected.taskTitle ?? '' }}</span>
              <UBadge
                class="shrink-0"
                :label="runBadge(selected).label"
                :color="runBadge(selected).color"
                variant="subtle"
                size="xs"
              />
              <span class="min-w-0 truncate text-xs text-muted">Run #{{ selected.number }} · {{ duration(selected.startedAt, selected.endedAt, now) }} · {{ runTokens(selected) }}<template v-if="selected.runnerName"> · on <span data-testid="run-runner">{{ selected.runnerName }}</span></template></span>
              <div class="ms-auto flex shrink-0 gap-2">
                <UButton
                  v-if="selected.taskRef"
                  label="Open task"
                  variant="outline"
                  color="neutral"
                  size="xs"
                  @click="flyout.toggle(selected.taskRef)"
                />
                <UButton
                  v-if="isLive(selected)"
                  label="Stop run"
                  color="error"
                  variant="subtle"
                  size="xs"
                  @click="stop(selected)"
                />
              </div>
            </header>
            <RunTranscript
              :events="events"
              :live="isLive(selected)"
              :agent-name="agent.name"
              :mine="sent[selected.id]"
            />
            <footer class="border-t border-default px-4 py-2">
              <RunComposer
                :view="view"
                :run="selected"
              />
            </footer>
          </template>
          <div
            v-else
            class="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted"
          >
            <span v-if="agent.role === 'pm'">{{ agent.name }} isn't running. {{ agent.name }} only runs when you send a message in Plan.</span>
            <span v-else>{{ agent.name }} is idle.</span>
          </div>
        </div>
        <TaskFlyout />
      </div>
    </div>
  </UDashboardPanel>
</template>
