<script setup lang="ts">
import type { Run } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { groupAgents, todayStats } from '~/utils/agents'
import { duration, projectColor, ROLE, timeAgo, tokens } from '~/utils/labels'

// The mobile Agents tab (design/mobile.md): working agents with their live
// run, the idle ones, and today's totals. Status follows the live
// connection; tapping an agent opens its page.
const live = useLive()
const state = live.state
const runs = ref<Run[]>([])
const now = ref(Date.now())

async function load() {
  try {
    runs.value = await api.runs.list()
  } catch {
    // The agents still list from live state without their runs
  }
}
onMounted(() => {
  void load()
  const timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  const stop = live.subscribe((event) => {
    if (event.type !== 'run.updated') return
    const i = runs.value.findIndex(r => r.id === event.run.id)
    if (i >= 0) runs.value.splice(i, 1, event.run)
    else runs.value.unshift(event.run)
  })
  onBeforeUnmount(() => {
    clearInterval(timer)
    stop()
  })
})

const groups = computed(() => groupAgents(state.value.agents, runs.value))
const today = computed(() => todayStats(runs.value, Object.values(state.value.tasks).flat(), now.value))
const project = (run: Run) => state.value.projects.find(p => p.id === run.projectId) ?? null
const to = (name: string) => `/agents/${name.toLowerCase()}`

function idleLine(row: { agent: { role: string, paused: boolean, pausedUntil: string | null }, run: Run | null }): string {
  if (row.agent.role === 'pm') return 'Runs only when you message it in Plan'
  if (row.agent.paused) return 'Paused'
  if (row.agent.pausedUntil && new Date(row.agent.pausedUntil).getTime() > now.value) return `Waiting on usage limit until ${new Date(row.agent.pausedUntil).toLocaleTimeString()}`
  if (!row.run) return 'No runs yet'
  return `Last run ${timeAgo(row.run.endedAt ?? row.run.queuedAt, now.value)}${row.run.taskRef ? ` · ${row.run.taskRef}` : ''}`
}
</script>

<template>
  <div class="flex flex-col gap-6 p-4">
    <section
      v-if="groups.working.length > 0"
      aria-labelledby="agents-working"
      class="flex flex-col gap-2"
    >
      <h2
        id="agents-working"
        class="text-sm font-semibold text-highlighted"
      >
        Working now
      </h2>
      <NuxtLink
        v-for="row in groups.working"
        :key="row.agent.id"
        :to="to(row.agent.name)"
        class="flex items-start gap-3 rounded-lg border border-primary/50 bg-default p-3 ring-2 ring-primary/10"
        data-testid="agent-row"
      >
        <AgentAvatar
          :name="row.agent.name"
          working
          size="lg"
        />
        <span class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="flex items-center gap-2">
            <span class="font-semibold text-highlighted">{{ row.agent.name }}</span>
            <span class="text-sm text-muted">{{ ROLE[row.agent.role] }}</span>
            <UBadge
              label="Working"
              color="success"
              variant="subtle"
              size="sm"
              class="ms-auto"
            />
          </span>
          <span
            v-if="row.run"
            class="truncate text-sm text-default"
          >{{ row.run.taskRef ?? 'Plan' }} {{ row.run.taskTitle ?? row.run.summary ?? 'PM turn' }}</span>
          <span
            v-if="row.run"
            class="flex items-center gap-1.5 text-xs text-muted"
          >
            <span
              v-if="project(row.run)"
              class="size-2 shrink-0 rounded-full"
              :style="{ backgroundColor: projectColor(project(row.run)!) }"
              aria-hidden="true"
            />
            <span class="truncate">{{ project(row.run)?.name }} · Run #{{ row.run.number }} · {{ duration(row.run.startedAt, row.run.endedAt, now) }}</span>
          </span>
        </span>
      </NuxtLink>
    </section>

    <section
      v-if="groups.idle.length > 0"
      aria-labelledby="agents-idle"
      class="flex flex-col gap-2"
    >
      <h2
        id="agents-idle"
        class="text-sm font-semibold text-highlighted"
      >
        Idle
      </h2>
      <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default">
        <li
          v-for="row in groups.idle"
          :key="row.agent.id"
        >
          <NuxtLink
            :to="to(row.agent.name)"
            class="flex items-center gap-3 p-3"
            data-testid="agent-row"
          >
            <AgentAvatar
              :name="row.agent.name"
              size="lg"
            />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="flex items-center gap-2">
                <span class="font-semibold text-highlighted">{{ row.agent.name }}</span>
                <span class="text-sm text-muted">{{ ROLE[row.agent.role] }}</span>
                <UBadge
                  :label="row.agent.paused ? 'Paused' : 'Idle'"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  class="ms-auto"
                />
              </span>
              <span class="truncate text-xs text-muted">{{ idleLine(row) }}</span>
            </span>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 shrink-0 text-dimmed"
            />
          </NuxtLink>
        </li>
      </ul>
    </section>

    <p
      v-if="state.loaded && state.agents.length === 0"
      class="text-sm text-muted"
    >
      No agents yet.
    </p>

    <section
      aria-labelledby="agents-today"
      class="flex flex-col gap-2"
    >
      <h2
        id="agents-today"
        class="text-sm font-semibold text-highlighted"
      >
        Today
      </h2>
      <div class="grid grid-cols-3 gap-2">
        <dl
          v-for="tile in [{ label: 'Runs', value: String(today.runs) }, { label: 'PRs merged', value: String(today.merged) }, { label: 'Usage', value: tokens(today.tokens) }]"
          :key="tile.label"
          class="rounded-lg border border-default p-3"
        >
          <dt class="text-xs text-muted">
            {{ tile.label }}
          </dt>
          <dd class="text-2xl font-semibold text-highlighted tabular-nums">
            {{ tile.value }}
          </dd>
        </dl>
      </div>
      <p class="text-xs text-muted">
        Usage is in tokens from your own subscription. Agents are shared by every project.
      </p>
    </section>
  </div>
</template>
