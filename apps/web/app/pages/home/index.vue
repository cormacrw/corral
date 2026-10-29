<script setup lang="ts">
import type { Agent, Run } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { dashboardCounts, elapsed, IN_PROGRESS_STAGES } from '~/utils/dashboard'
import { initials, isWorking, projectColor, ROLE, STATUS } from '~/utils/labels'

// Home, the global dashboard (design/mobile.md). Counts come from the live
// task lists the shell loads; the active runs come from /api/runs and are
// refetched whenever a run changes.
const live = useLive()
const state = live.state
useSeoMeta({ title: 'Home · Corral' })

// All projects, or one project's numbers
const projectId = ref<string>('all')
const projectItems = computed(() => [
  { label: 'All projects', value: 'all' },
  ...state.value.projects.map(p => ({ label: p.name, value: p.id }))
])
const scope = computed(() => projectId.value === 'all' ? state.value.projects : state.value.projects.filter(p => p.id === projectId.value))

// Re-render the "today" and elapsed numbers as time passes
const now = ref(Date.now())
const counts = computed(() => dashboardCounts(scope.value.flatMap(p => state.value.tasks[p.id] ?? []), new Date(now.value)))
const loading = computed(() => !state.value.loaded || scope.value.some(p => !state.value.tasks[p.id]))

const STAGE_COLOR: Record<typeof IN_PROGRESS_STAGES[number], string> = {
  in_progress: 'var(--ui-primary)',
  agent_review: 'color-mix(in oklab, var(--ui-primary) 55%, var(--ui-bg))',
  human_review: 'var(--ui-warning)',
  ready_to_merge: 'var(--ui-success)'
}
const stages = computed(() => IN_PROGRESS_STAGES.map(s => ({ key: s, label: STATUS[s].label, count: counts.value.stages[s], color: STAGE_COLOR[s] })))
const attention = computed(() => {
  const { blocked, waitingForReview } = counts.value
  const parts = [blocked && `${blocked} blocked`, waitingForReview && `${waitingForReview} waiting for your review`].filter(Boolean)
  return parts.length ? parts.join(', ') : null
})

const runs = ref<Run[]>([])
async function loadRuns() {
  try {
    runs.value = await api.runs.list({ active: true })
  } catch {
    // The agents still show, just without their current run
  }
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void loadRuns()
  const stop = live.subscribe((event) => {
    if (event.type === 'run.updated') void loadRuns()
  })
  timer = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
  onBeforeUnmount(() => {
    stop()
    clearInterval(timer)
  })
})

const taskOf = (run: Run) => run.taskId ? state.value.tasks[run.projectId]?.find(t => t.id === run.taskId) : undefined
const projectOf = (id: string) => state.value.projects.find(p => p.id === id)
// One line per active run: what it's on, where, and for how long
const runLines = (agent: Agent) => runs.value
  .filter(r => r.agentId === agent.id && scope.value.some(p => p.id === r.projectId))
  .map((run) => {
    const task = taskOf(run)
    const session = run.taskId ? null : state.value.planSessions.find(s => s.activeRunId === run.id)
    return {
      id: run.id,
      ref: run.taskRef,
      title: run.taskTitle ?? (session ? `Answering in ${session.title}` : 'Planning'),
      project: projectOf(run.projectId),
      status: task ? STATUS[task.status].label : null,
      // Reviews are about the PR; developer runs are about the run
      link: run.role === 'reviewer' && task?.prNumber ? `PR #${task.prNumber}` : `Run #${run.number}`,
      elapsed: elapsed(run.startedAt ?? run.queuedAt, now.value)
    }
  })
const agents = computed(() => state.value.agents
  .map(agent => ({ agent, lines: runLines(agent), working: isWorking(agent) }))
  // Working agents first, in the shell's order otherwise
  .sort((a, b) => Number(b.working) - Number(a.working)))
const agentBadge = (agent: Agent) => isWorking(agent)
  ? { label: 'Working', color: 'success' as const }
  : agent.paused || agent.pausedUntil ? { label: 'Paused', color: 'warning' as const } : { label: 'Idle', color: 'neutral' as const }

const byProject = computed(() => state.value.projects.map((project) => {
  const c = dashboardCounts(state.value.tasks[project.id] ?? [], new Date(now.value))
  return { project, todo: c.todo, inProgress: c.inProgress, merged: c.mergedToday, loaded: Boolean(state.value.tasks[project.id]) }
}))
</script>

<template>
  <UDashboardPanel>
    <div
      class="mx-auto flex w-full max-w-[640px] flex-col gap-4 p-4"
      data-testid="home-dashboard"
    >
      <div class="flex flex-wrap items-center gap-1.5 text-sm text-muted">
        <span
          :class="['size-2 rounded-full', state.runner?.online ? 'bg-success' : 'bg-error']"
          aria-hidden="true"
        />
        Runner {{ state.runner?.online ? 'online' : 'offline' }} ·
        <UDropdownMenu :items="projectItems.map(item => ({ label: item.label, onSelect: () => { projectId = item.value } }))">
          <UButton
            :label="projectItems.find(item => item.value === projectId)?.label ?? 'All projects'"
            trailing-icon="i-lucide-chevron-down"
            variant="link"
            color="neutral"
            size="sm"
            class="p-0 text-sm text-muted"
            aria-label="Project"
            data-testid="home-project"
          />
        </UDropdownMenu>
        · Today
      </div>

      <!-- Count tiles -->
      <div class="grid grid-cols-3 gap-2">
        <dl
          v-for="tile in [
            { key: 'todo', label: 'To do', dot: 'bg-info', value: counts.todo, sub: 'Ready, not started' },
            { key: 'in-progress', label: 'In progress', dot: 'bg-primary', value: counts.inProgress, sub: 'Building to merge' },
            { key: 'merged', label: 'Merged today', dot: 'bg-success', value: counts.mergedToday, sub: `${counts.firstPassToday} first-pass` }
          ]"
          :key="tile.key"
          class="flex flex-col rounded-lg border border-default p-3"
          :data-testid="`home-${tile.key}`"
        >
          <dt class="flex items-start gap-1.5 text-xs text-muted">
            <span
              :class="['mt-1 size-2 shrink-0 rounded-full', tile.dot]"
              aria-hidden="true"
            />{{ tile.label }}
          </dt>
          <dd class="text-3xl font-semibold tabular-nums text-highlighted">
            <USkeleton
              v-if="loading"
              class="my-1 h-7 w-8"
            />
            <template v-else>
              {{ tile.value }}
            </template>
          </dd>
          <dd class="text-xs text-muted">
            {{ tile.sub }}
          </dd>
        </dl>
      </div>

      <!-- In progress by stage -->
      <section
        class="flex flex-col gap-3 rounded-lg border border-default p-3"
        data-testid="home-stages"
      >
        <header class="flex items-center justify-between">
          <h2 class="text-sm font-semibold text-highlighted">
            In progress by stage
          </h2>
          <span class="text-xs text-muted">{{ counts.inProgress }} {{ counts.inProgress === 1 ? 'task' : 'tasks' }}</span>
        </header>
        <div
          class="flex h-2 gap-0.5 overflow-hidden rounded-full bg-elevated"
          role="img"
          :aria-label="stages.map(s => `${s.label} ${s.count}`).join(', ')"
        >
          <span
            v-for="stage in stages.filter(s => s.count > 0)"
            :key="stage.key"
            class="h-full"
            :style="{ flex: stage.count, background: stage.color }"
            :title="`${stage.label}: ${stage.count}`"
          />
        </div>
        <ul class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          <li
            v-for="stage in stages"
            :key="stage.key"
            class="flex items-center gap-2"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :style="{ background: stage.color }"
              aria-hidden="true"
            />
            <span class="flex-1 truncate">{{ stage.label }}</span>
            <span class="font-semibold tabular-nums text-highlighted">{{ stage.count }}</span>
          </li>
        </ul>
        <NuxtLink
          v-if="attention"
          to="/inbox"
          :class="['flex items-center gap-2 rounded-md border px-3 py-2 text-sm', counts.blocked ? 'border-error/30 bg-error/10' : 'border-warning/30 bg-warning/10']"
          data-testid="home-attention"
        >
          <UIcon
            name="i-lucide-triangle-alert"
            :class="['size-4 shrink-0', counts.blocked ? 'text-error' : 'text-warning']"
          />
          <span class="flex-1">{{ attention }}</span>
          <UIcon
            name="i-lucide-chevron-right"
            class="size-4 text-muted"
          />
        </NuxtLink>
      </section>

      <!-- Agents -->
      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-semibold text-highlighted">
          Agents
        </h2>
        <ul class="flex flex-col gap-2">
          <li
            v-for="{ agent, lines, working } in agents"
            :key="agent.id"
          >
            <NuxtLink
              :to="`/agents/${agent.name.toLowerCase()}`"
              :class="['flex flex-col gap-2 rounded-lg border p-3', working ? 'border-primary/60 ring-2 ring-primary/15' : 'border-default']"
              :data-testid="`home-agent-${agent.name.toLowerCase()}`"
            >
              <div class="flex items-center gap-2">
                <AgentAvatar
                  :name="agent.name"
                  :working="working"
                />
                <span class="font-semibold text-highlighted">{{ agent.name }}</span>
                <span class="text-sm text-muted">{{ ROLE[agent.role] }}</span>
                <UBadge
                  v-bind="agentBadge(agent)"
                  variant="subtle"
                  size="sm"
                  class="ms-auto"
                />
              </div>
              <div
                v-for="line in lines"
                :key="line.id"
                class="ps-10"
              >
                <p class="truncate">
                  <span
                    v-if="line.ref"
                    class="me-1 font-mono text-xs text-muted"
                  >{{ line.ref }}</span>
                  <span class="font-medium text-highlighted">{{ line.title }}</span>
                </p>
                <p class="flex items-center gap-1.5 truncate text-xs text-muted">
                  <span
                    v-if="line.project"
                    class="size-2 shrink-0 rounded-full"
                    :style="{ background: projectColor(line.project) }"
                    aria-hidden="true"
                  />
                  {{ [line.project?.name, line.status, line.link, line.elapsed].filter(Boolean).join(' · ') }}
                </p>
              </div>
            </NuxtLink>
          </li>
        </ul>
        <p
          v-if="state.loaded && agents.length === 0"
          class="text-sm text-muted"
        >
          No agents yet.
        </p>
      </section>

      <!-- By project -->
      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-semibold text-highlighted">
          By project
        </h2>
        <div
          class="rounded-lg border border-default text-sm"
          role="table"
          aria-label="Tasks by project"
        >
          <div
            class="grid grid-cols-[minmax(0,1fr)_2.75rem_4.5rem_3.25rem] gap-2 border-b border-default px-3 py-2 text-xs text-muted"
            role="row"
          >
            <span role="columnheader">Project</span>
            <span
              role="columnheader"
              class="text-end"
            >To do</span>
            <span
              role="columnheader"
              class="text-end"
            >In progress</span>
            <span
              role="columnheader"
              class="text-end"
            >Merged</span>
          </div>
          <NuxtLink
            v-for="row in byProject"
            :key="row.project.id"
            :to="`/projects/${row.project.slug}`"
            class="grid grid-cols-[minmax(0,1fr)_2.75rem_4.5rem_3.25rem] items-center gap-2 border-b border-default px-3 py-2.5 last:border-b-0"
            role="row"
            :data-testid="`home-project-${row.project.slug}`"
          >
            <span
              role="cell"
              class="flex min-w-0 items-center gap-2 font-medium text-highlighted"
            >
              <span
                class="flex size-6 shrink-0 items-center justify-center rounded text-xs font-semibold text-white"
                :style="{ background: projectColor(row.project) }"
                aria-hidden="true"
              >{{ initials(row.project.name).slice(0, 1) }}</span>
              <span class="truncate">{{ row.project.name }}</span>
              <UBadge
                v-if="row.project.paused"
                label="Paused"
                color="warning"
                variant="subtle"
                size="sm"
              />
            </span>
            <span
              v-for="(value, i) in [row.todo, row.inProgress, row.merged]"
              :key="i"
              role="cell"
              class="text-end tabular-nums text-highlighted"
            >{{ row.loaded ? value : '–' }}</span>
          </NuxtLink>
          <p
            v-if="state.loaded && byProject.length === 0"
            class="px-3 py-2.5 text-muted"
          >
            No projects yet.
          </p>
        </div>
      </section>
    </div>
  </UDashboardPanel>
</template>
