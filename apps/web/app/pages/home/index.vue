<script setup lang="ts">
import type { Agent, Run } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { todayStats } from '~/utils/agents'
import { dashboardCounts, elapsed, IN_PROGRESS_STAGES, liveRunTitle } from '~/utils/dashboard'
import { agentStatus, epicInProgress, epicWithLiveCounts, isLiveRun, isWorking, projectColor, ROLE, STATUS, tokens } from '~/utils/labels'

// Home, the global dashboard (design/mobile.md). Counts come from the live
// task lists the shell loads; runs come from /api/runs and are
// refetched whenever a run changes.
const live = useLive()
const state = live.state
const lists = useAllProjectLists(() => state.value.projects)
useSeoMeta({ title: 'Home · Corral' })

// All projects, or one project's numbers
const projectId = ref<string>('all')
const projectItems = computed(() => [
  { label: 'All projects', value: 'all' },
  ...state.value.projects.map(p => ({ label: p.name, value: p.id }))
])
const scope = computed(() => projectId.value === 'all' ? state.value.projects : state.value.projects.filter(p => p.id === projectId.value))

const epics = computed(() => scope.value
  .flatMap(project => (lists.epics.value[project.id] ?? []).map(epic => ({ epic: epicWithLiveCounts(epic, lists.tasks.value[project.id] ?? []), project })))
  .filter(({ epic }) => epicInProgress(epic))
  .sort((a, b) => Date.parse(b.epic.updatedAt) - Date.parse(a.epic.updatedAt)))

// Re-render the "today" and elapsed numbers as time passes
const now = ref(Date.now())
const counts = computed(() => dashboardCounts(scope.value.flatMap(p => lists.tasks.value[p.id] ?? []), new Date(now.value)))
const loading = computed(() => !state.value.loaded || scope.value.some(p => lists.pending.value[p.id] ?? true))

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
const today = computed(() => todayStats(
  runs.value.filter(r => scope.value.some(p => p.id === r.projectId)),
  [],
  now.value
))
async function loadRuns() {
  try {
    runs.value = await api.runs.list()
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

const taskOf = (run: Run) => run.taskId ? lists.tasks.value[run.projectId]?.find(t => t.id === run.taskId) : undefined
const projectOf = (id: string) => state.value.projects.find(p => p.id === id)
// One line per active run: what it's on, where, and for how long
const runLines = (agent: Agent) => runs.value
  .filter(r => isLiveRun(r) && r.agentId === agent.id && scope.value.some(p => p.id === r.projectId))
  .map((run) => {
    const task = taskOf(run)
    const session = run.taskId ? null : state.value.planSessions.find(s => s.activeRunId === run.id)
    return {
      id: run.id,
      ref: run.taskRef ?? (run.epicId ? 'Epic' : null),
      title: liveRunTitle(run, session?.title ?? null),
      project: projectOf(run.projectId),
      status: task ? STATUS[task.status].label : null,
      // Reviews are about the PR; developer runs are about the run
      link: run.role === 'reviewer' && task?.pr?.number ? `PR #${task.pr?.number}` : `Run #${run.number}`,
      elapsed: elapsed(run.startedAt ?? run.queuedAt, now.value)
    }
  })
const agents = computed(() => state.value.agents
  .map(agent => ({ agent, lines: runLines(agent), working: isWorking(agent) }))
  // Working agents first, in the shell's order otherwise
  .sort((a, b) => Number(b.working) - Number(a.working)))
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
        {{ (state.runner?.runners.length ?? 0) > 1 ? `${state.runner!.runners.filter(r => r.online).length} of ${state.runner!.runners.length} runners online` : `Runner ${state.runner?.online ? 'online' : 'offline'}` }} ·
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
            { key: 'merged', label: 'Completed today', dot: 'bg-success', value: counts.mergedToday, sub: `${counts.firstPassToday} first-pass` }
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

      <!-- Today's agent totals, scoped to the same project filter -->
      <section class="flex flex-col gap-2">
        <div class="grid grid-cols-2 gap-2">
          <dl
            v-for="tile in [{ key: 'runs', label: 'Runs', value: String(today.runs) }, { key: 'usage', label: 'Usage', value: tokens(today.tokens) }]"
            :key="tile.key"
            class="rounded-lg border border-default p-3"
            :data-testid="`home-${tile.key}`"
          >
            <dt class="text-xs text-muted">
              {{ tile.label }}
            </dt>
            <dd class="text-2xl font-semibold tabular-nums text-highlighted">
              {{ tile.value }}
            </dd>
          </dl>
        </div>
        <p class="text-xs text-muted">
          Usage is in tokens from your own subscription.
        </p>
      </section>

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
                <span
                  v-if="agentStatus(agent, now, false)"
                  class="ms-auto text-xs text-muted"
                >{{ agentStatus(agent, now, false)?.label }}</span>
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

      <section
        class="flex flex-col gap-2"
        data-testid="home-epics"
      >
        <h2 class="text-sm font-semibold text-highlighted">
          Epics
        </h2>
        <ul
          v-if="epics.length"
          class="flex flex-col gap-3"
        >
          <li
            v-for="{ epic, project } in epics"
            :key="epic.id"
          >
            <p
              v-if="projectId === 'all'"
              class="mb-1 flex items-center gap-1.5 text-xs text-muted"
            >
              <span
                class="size-2 shrink-0 rounded-full"
                :style="{ background: projectColor(project) }"
                aria-hidden="true"
              />
              {{ project.name }}
            </p>
            <EpicProgressRow
              :id="epic.id"
              :title="epic.title"
              :merged="epic.mergedCount"
              :total="epic.taskCount"
              :epic="epic"
            />
          </li>
        </ul>
        <p
          v-else
          class="text-sm text-muted"
        >
          No epics in progress.
        </p>
      </section>
    </div>
  </UDashboardPanel>
</template>
