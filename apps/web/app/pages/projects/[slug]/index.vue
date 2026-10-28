<script setup lang="ts">
import type { AuditEntry, Inbox, Run, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { duration, epicTitle, initials, projectColor, STATUS, timeAgo } from '~/utils/labels'

// Project overview (design/project-overview.md)
const route = useRoute()
const live = useLive()
const slug = computed(() => String(route.params.slug))
const project = computed(() => live.state.value.projects.find(p => p.slug === slug.value) ?? null)
const tasks = computed<Task[]>(() => project.value ? live.state.value.tasks[project.value.id] ?? [] : [])
const inbox = ref<Inbox | null>(null)
const runs = ref<Run[]>([])
const history = ref<AuditEntry[]>([])
const error = ref<string | null>(null)
useSeoMeta({ title: () => `${project.value?.name ?? 'Project'} · Corral` })

async function load() {
  error.value = null
  try {
    if (project.value && !live.state.value.tasks[project.value.id]) await live.loadTasks(project.value)
    const [i, r] = await Promise.all([api.inbox.get(), api.runs.list({ active: true })])
    inbox.value = i
    runs.value = r.filter(run => run.projectId === project.value?.id)
    // Recent activity: the newest audit entries of this project's tasks
    const recent = [...tasks.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
    const entries = await Promise.all(recent.map(t => api.tasks.history(slug.value, t.number)))
    history.value = entries.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
watch(project, () => void load(), { immediate: true })
onMounted(() => {
  const stop = live.subscribe((event) => {
    if (event.type === 'task.updated' || event.type === 'run.updated' || event.type === 'task.deleted') void load()
  })
  onBeforeUnmount(stop)
})

const DOT = { neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-error', success: 'bg-success', secondary: 'bg-secondary' } as const
const count = (status: Task['status']) => tasks.value.filter(t => t.status === status).length
const needsYou = computed(() => inbox.value?.needsYou.filter(i => i.project.id === project.value?.id) ?? [])
const weekAgo = Date.now() - 7 * 86_400_000
const mergedThisWeek = computed(() => tasks.value.filter(t => t.mergedAt && new Date(t.mergedAt).getTime() > weekAgo))
const firstPass = computed(() => {
  const merged = tasks.value.filter(t => t.status === 'merged')
  if (merged.length === 0) return null
  return Math.round(100 * merged.filter(t => t.reviewRounds === 0).length / merged.length)
})
const waitingOnDependency = computed(() => tasks.value.filter(t => t.status === 'ready' && t.dependsOn.some(ref => tasks.value.find(x => x.ref === ref)?.status !== 'merged')).length)
const developer = computed(() => live.state.value.agents.find(a => a.role === 'developer'))
const reviewer = computed(() => live.state.value.agents.find(a => a.role === 'reviewer'))
const epics = computed(() => {
  const groups = new Map<string, { id: string, title: string, merged: number, total: number }>()
  for (const task of tasks.value) {
    const id = task.epicId ?? 'none'
    const group = groups.get(id) ?? { id, title: id === 'none' ? 'No epic' : epicTitle(live.state.value.epics[project.value?.id ?? ''], id, groups.size), merged: 0, total: 0 }
    group.total++
    if (task.status === 'merged') group.merged++
    groups.set(id, group)
  }
  return [...groups.values()]
})
const taskOf = (run: Run) => tasks.value.find(t => t.id === run.taskId)
const actorName = (entry: AuditEntry) => entry.actor.kind === 'human' ? 'You' : entry.actor.kind === 'agent' ? (entry.actor.role === 'pm' ? live.state.value.agents.find(a => a.role === 'pm')?.name ?? 'PM' : entry.actor.role === 'developer' ? developer.value?.name ?? 'Developer' : reviewer.value?.name ?? 'Reviewer') : 'Corral'
const taskRefOf = (entry: AuditEntry) => tasks.value.find(t => t.id === entry.taskId)?.ref ?? ''
const activityText = (entry: AuditEntry) => {
  const d = entry.detail
  if (entry.action === 'task.transition') return `${String(d.from).replaceAll('_', ' ')} → ${String(d.to).replaceAll('_', ' ')}`
  if (entry.action === 'review.recorded') return String(d.verdict).replaceAll('_', ' ')
  if (entry.action === 'task.claimed') return 'claimed'
  if (entry.action === 'run.ended') return `run ended ${String(d.state)}`
  return entry.action.replace('task.', '').replaceAll('.', ' ')
}
</script>

<template>
  <UDashboardPanel>
    <div
      v-if="!project"
      class="p-6"
    >
      <USkeleton class="h-8 w-64" />
    </div>
    <div
      v-else
      class="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-6"
    >
      <header class="flex flex-wrap items-center gap-4">
        <span
          class="flex size-11 items-center justify-center rounded-lg text-lg font-semibold text-white"
          :style="{ background: projectColor(project) }"
        >{{ initials(project.name) }}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h1 class="text-2xl font-semibold">
              {{ project.name }}
            </h1>
            <UBadge
              :label="project.paused ? 'Paused' : 'Running'"
              :color="project.paused ? 'warning' : 'success'"
              variant="subtle"
            />
          </div>
          <p class="text-sm text-muted">
            <span class="font-mono">github.com/{{ project.repository }}</span> · Branch {{ project.defaultBranch }} · Task IDs {{ project.prefix }}-{{ project.nextTaskNumber }}
          </p>
        </div>
        <div class="flex gap-2">
          <UButton
            :to="`/plan?project=${project.id}`"
            label="Plan with Juno"
            variant="outline"
            color="neutral"
            icon="i-lucide-message-square"
          />
          <UButton
            :to="`/projects/${project.slug}/board`"
            label="Open board"
          />
        </div>
      </header>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error"
        :actions="[{ label: 'Retry', onClick: load }]"
      />

      <div
        v-if="tasks.length === 0"
        class="rounded-lg border border-default p-8 text-center"
      >
        <p class="mb-3 text-muted">
          Plan your first epic with Juno
        </p>
        <UButton
          :to="`/plan?project=${project.id}`"
          label="Plan with Juno"
        />
      </div>

      <div class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        <dl
          v-for="tile in [
            { label: 'Ready', color: STATUS.ready.color, value: count('ready'), sub: waitingOnDependency ? `${waitingOnDependency} waiting on a dependency` : 'scheduled next' },
            { label: 'In progress', color: STATUS.in_progress.color, value: count('in_progress'), sub: runs.some(r => r.role === 'developer') ? `${developer?.name ?? 'Developer'} working` : 'no run active' },
            { label: 'Agent review', color: STATUS.agent_review.color, value: count('agent_review'), sub: runs.some(r => r.role === 'reviewer') ? `${reviewer?.name ?? 'Reviewer'} reviewing` : 'waiting' },
            { label: 'Needs you', color: STATUS.human_review.color, value: needsYou.length, sub: `${count('human_review')} review · ${count('blocked')} blocked · ${count('failed')} failed` },
            { label: 'Merged this week', color: STATUS.merged.color, value: mergedThisWeek.length, sub: firstPass === null ? 'no merges yet' : `first-pass approval ${firstPass}%` }
          ]"
          :key="tile.label"
          class="rounded-lg border border-default p-3"
        >
          <dt class="flex items-center gap-1.5 text-xs text-muted">
            <span
              :class="['size-2 rounded-full', DOT[tile.color]]"
              aria-hidden="true"
            />{{ tile.label }}
          </dt>
          <dd class="text-2xl font-semibold tabular-nums">
            {{ tile.value }}
          </dd>
          <dd class="truncate text-xs text-muted">
            {{ tile.sub }}
          </dd>
        </dl>
      </div>

      <div class="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-6">
        <div class="flex flex-col gap-6">
          <section class="rounded-lg border border-default">
            <header class="flex items-center gap-2 border-b border-default px-3 py-2">
              <h2 class="font-medium">
                Needs you
              </h2>
              <UBadge
                :label="String(needsYou.length)"
                size="sm"
                :color="needsYou.length ? 'primary' : 'neutral'"
                variant="subtle"
              />
              <UButton
                to="/inbox"
                label="Open Inbox"
                variant="link"
                size="sm"
                class="ms-auto"
              />
            </header>
            <ul v-if="needsYou.length > 0">
              <li
                v-for="item in needsYou"
                :key="item.id"
              >
                <NuxtLink
                  :to="`/inbox/${item.id}`"
                  class="flex items-center gap-2 px-3 py-2 text-sm hover:bg-elevated"
                >
                  <UBadge
                    :label="item.type.replace('_', ' ')"
                    size="xs"
                    variant="subtle"
                    :color="item.type === 'human_review' ? 'warning' : 'error'"
                  />
                  <span class="font-mono text-xs text-muted">{{ item.taskRef }}</span>
                  <span class="min-w-0 flex-1 truncate">{{ item.subject }}</span>
                  <span class="text-xs text-dimmed">{{ timeAgo(item.at) }}</span>
                </NuxtLink>
              </li>
            </ul>
            <p
              v-else
              class="px-3 py-4 text-sm text-muted"
            >
              Nothing is waiting on you.
            </p>
          </section>

          <section>
            <h2 class="mb-2 font-medium">
              Active now
            </h2>
            <div
              v-if="runs.length > 0"
              class="flex flex-col gap-2"
            >
              <NuxtLink
                v-for="run in runs"
                :key="run.id"
                :to="`/agents/${run.agentName.toLowerCase()}/${run.id}`"
                class="flex items-center gap-3 rounded-lg border border-primary/40 p-3 outline-primary hover:bg-elevated motion-safe:animate-pulse"
              >
                <AgentAvatar
                  :name="run.agentName"
                  working
                />
                <div class="min-w-0">
                  <p class="truncate text-sm">
                    {{ run.agentName }} is {{ run.role === 'reviewer' ? 'reviewing' : run.role === 'pm' ? 'planning' : 'building' }} {{ run.taskRef ?? '' }} {{ taskOf(run)?.title ?? '' }}
                  </p>
                  <p class="text-xs text-muted">
                    Run #{{ run.number }} · {{ duration(run.startedAt ?? run.queuedAt, null) }} · {{ run.state.replace('_', ' ') }}
                  </p>
                </div>
              </NuxtLink>
            </div>
            <p
              v-else
              class="text-sm text-muted"
            >
              No agent is working on this project right now.
            </p>
          </section>
        </div>

        <div class="flex flex-col gap-6">
          <section>
            <div class="mb-2 flex items-center">
              <h2 class="font-medium">
                Epics
              </h2>
              <UButton
                :to="`/projects/${project.slug}/backlog`"
                label="Open Backlog"
                variant="link"
                size="sm"
                class="ms-auto"
              />
            </div>
            <ul class="flex flex-col gap-3">
              <li
                v-for="epic in epics"
                :key="epic.id"
              >
                <div class="flex justify-between text-sm">
                  <NuxtLink
                    v-if="epic.id !== 'none'"
                    :to="`/epics/${epic.id}`"
                    class="hover:text-primary hover:underline"
                  >{{ epic.title }}</NuxtLink>
                  <span v-else>{{ epic.title }}</span>
                  <span class="text-muted">{{ epic.merged }} of {{ epic.total }} merged</span>
                </div>
                <div
                  role="meter"
                  :aria-label="`${epic.title}: ${epic.merged} of ${epic.total} tasks merged`"
                  :aria-valuenow="epic.merged"
                  aria-valuemin="0"
                  :aria-valuemax="epic.total"
                  class="mt-1 flex h-1.5 gap-0.5"
                >
                  <span
                    class="rounded-full bg-primary"
                    :style="{ flex: epic.merged }"
                  />
                  <span
                    class="rounded-full bg-accented"
                    :style="{ flex: epic.total - epic.merged }"
                  />
                </div>
              </li>
              <li
                v-if="epics.length === 0"
                class="text-sm text-muted"
              >
                No epics yet.
              </li>
            </ul>
          </section>

          <section>
            <h2 class="mb-2 font-medium">
              Recent activity
            </h2>
            <ol class="flex flex-col gap-2 text-sm">
              <li
                v-for="entry in history"
                :key="entry.id"
                class="flex gap-2"
              >
                <span
                  class="mt-2 size-1.5 shrink-0 rounded-full bg-accented"
                  aria-hidden="true"
                />
                <span class="min-w-0 truncate">
                  <span class="font-medium">{{ actorName(entry) }}</span>{{ ' ' }}
                  <span class="text-muted">{{ activityText(entry) }}</span>{{ ' ' }}
                  <NuxtLink
                    :to="`/tasks/${taskRefOf(entry)}`"
                    class="font-mono text-xs text-muted hover:underline"
                  >{{ taskRefOf(entry) }}</NuxtLink>
                  <span class="ms-2 text-xs text-dimmed">{{ timeAgo(entry.createdAt) }}</span>
                </span>
              </li>
              <li
                v-if="history.length === 0"
                class="text-sm text-muted"
              >
                Nothing yet.
              </li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  </UDashboardPanel>
</template>
