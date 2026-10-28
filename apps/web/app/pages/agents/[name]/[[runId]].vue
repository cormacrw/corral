<script setup lang="ts">
import type { Run, RunEvent } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { duration, ROLE, runBadge, timeAgo, tokens } from '~/utils/labels'

// An agent's page (design/agent.md): runs list and the transcript
const route = useRoute()
const router = useRouter()
const live = useLive()
const flyout = useTaskFlyout()
const toast = useToast()
const name = computed(() => String(route.params.name))
const agent = computed(() => live.state.value.agents.find(a => a.name.toLowerCase() === name.value.toLowerCase()) ?? null)
const runs = ref<Run[]>([])
const error = ref<string | null>(null)
const events = ref<RunEvent[]>([])
const now = ref(Date.now())
useSeoMeta({ title: () => `${agent.value?.name ?? 'Agent'} · Corral` })

const LIVE = ['queued', 'starting', 'running', 'waiting_for_input', 'stopping']
const isLive = (run: Run) => LIVE.includes(run.state)
const selectedId = computed(() => typeof route.params.runId === 'string' ? route.params.runId : null)
const current = computed(() => runs.value.find(isLive) ?? null)
const selected = computed(() => runs.value.find(r => r.id === selectedId.value) ?? current.value ?? runs.value[0] ?? null)

async function load() {
  if (!agent.value) return
  error.value = null
  try {
    runs.value = await api.runs.list({ agentId: agent.value.id })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
watch(agent, () => void load(), { immediate: true })
watch(selected, async (run, old) => {
  if (!run || run.id === old?.id) return
  try {
    events.value = await api.runs.transcript(run.id)
    live.watchRun(run.id, events.value)
  } catch {
    events.value = []
  }
}, { immediate: true })
onMounted(() => {
  const timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  const stop = live.subscribe((event) => {
    if (event.type === 'run.updated' && event.run.agentId === agent.value?.id) {
      const i = runs.value.findIndex(r => r.id === event.run.id)
      if (i >= 0) runs.value.splice(i, 1, event.run)
      else runs.value.unshift(event.run)
    }
    if (event.type === 'run.events' && event.runId === selected.value?.id) events.value.push(...event.events)
  })
  onBeforeUnmount(() => {
    clearInterval(timer)
    stop()
  })
})

const weekAgo = computed(() => now.value - 7 * 86_400_000)
const thisWeek = computed(() => runs.value.filter(r => new Date(r.queuedAt).getTime() > weekAgo.value))
const avgRun = computed(() => {
  const done = thisWeek.value.filter(r => r.startedAt && r.endedAt)
  if (done.length === 0) return '—'
  const ms = done.reduce((n, r) => n + new Date(r.endedAt!).getTime() - new Date(r.startedAt!).getTime(), 0) / done.length
  return `${Math.round(ms / 60_000)}m`
})
const today = computed(() => runs.value.filter(r => new Date(r.queuedAt).toDateString() === new Date(now.value).toDateString()))
const usageToday = computed(() => tokens(today.value.reduce((n, r) => n + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0)))
const tiles = computed(() => {
  if (!agent.value) return []
  const count = (outcome: string) => thisWeek.value.filter(r => r.outcome === outcome).length
  switch (agent.value.role) {
    case 'developer': return [
      { label: 'Runs this week', value: String(thisWeek.value.length), sub: `${today.value.length} today` },
      { label: 'PRs opened', value: String(count('pr_opened') + count('pr_updated')), sub: 'incl. revisions' },
      { label: 'Stuck', value: String(count('stuck')), sub: 'asked you' },
      { label: 'Avg run', value: avgRun.value, sub: 'this week' },
      { label: 'Usage today', value: usageToday.value, sub: 'tokens' }
    ]
    case 'reviewer': return [
      { label: 'Reviews this week', value: String(thisWeek.value.length), sub: `${today.value.length} today` },
      { label: 'Approved', value: String(count('approved')), sub: '' },
      { label: 'Changes requested', value: String(count('changes_requested')), sub: '' },
      { label: 'Avg review', value: avgRun.value, sub: 'this week' },
      { label: 'Usage today', value: usageToday.value, sub: 'tokens' }
    ]
    default: return [
      { label: 'Turns this week', value: String(thisWeek.value.length), sub: `${today.value.length} today` },
      { label: 'Avg turn', value: avgRun.value, sub: 'this week' },
      { label: 'Usage today', value: usageToday.value, sub: 'tokens' }
    ]
  }
})
const facts = computed(() => {
  if (!agent.value) return ''
  const where = agent.value.role === 'developer' ? 'one worktree per task' : agent.value.role === 'reviewer' ? 'a read-only task worktree' : 'a read-only checkout of the default branch'
  return `Concurrency ${agent.value.concurrency} · ${where} · .corral/agents/${agent.value.role}.md`
})
async function stop(run: Run) {
  try {
    await api.runs.stop(run.id)
    toast.add({ title: 'Run stopped', description: 'The task is paused until you resume it.', color: 'neutral' })
  } catch (e) {
    toast.add({ title: 'Could not stop', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
const projectName = (run: Run) => live.state.value.projects.find(p => p.id === run.projectId)?.name ?? ''
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
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
              :label="agent.activeRuns > 0 ? 'Working' : agent.paused ? 'Paused' : agent.pausedUntil && new Date(agent.pausedUntil).getTime() > now ? 'Waiting on usage limit' : 'Idle'"
              :color="agent.activeRuns > 0 ? 'success' : 'neutral'"
              variant="subtle"
            />
          </div>
          <p class="text-sm text-muted">
            {{ ROLE[agent.role] }} · Claude · {{ today.length }} runs today
            <span v-if="agent.pausedUntil && new Date(agent.pausedUntil).getTime() > now"> · Waiting on usage limit until {{ new Date(agent.pausedUntil).toLocaleTimeString() }}</span>
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
          <ul class="min-h-0 flex-1 overflow-y-auto">
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
              <span class="min-w-0 truncate text-xs text-muted">Run #{{ selected.number }} · {{ duration(selected.startedAt, selected.endedAt, now) }} · {{ tokens((selected.inputTokens ?? 0) + (selected.outputTokens ?? 0)) }} tokens</span>
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
            />
            <footer class="border-t border-default px-4 py-2 text-xs text-muted">
              <span v-if="isLive(selected)">Live. Mid-run messages aren't supported yet; comment on the task and {{ agent.name }} reads it on its next run.</span>
              <span v-else><UIcon
                name="i-lucide-lock"
                class="size-3"
              /> Read-only. This run finished {{ timeAgo(selected.endedAt, now) }}. To change the work, comment on the task.</span>
            </footer>
          </template>
          <div
            v-else
            class="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted"
          >
            <span v-if="agent.role === 'pm'">Juno isn't running. Juno only runs when you send a message in Plan.</span>
            <span v-else>{{ agent.name }} is idle.</span>
          </div>
        </div>
        <TaskFlyout />
      </div>
    </div>
  </UDashboardPanel>
</template>
