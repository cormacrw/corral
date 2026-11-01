<script setup lang="ts">
import type { AgentRuntime } from '@corral/contracts'
import { useQuery } from '@tanstack/vue-query'
import { provide } from 'vue'
import { FLYOUT_SHEETS } from '~/composables/useTaskFlyout'
import { planDraftsQuery, planSessionsQuery } from '~/queries/plan'
import { useDraft } from '~/composables/useDraft'
import { reloadShell } from '~/queries/shell'
import { clisQuery } from '~/queries/setup'
import { detectedRuntimes, projectColor, runtimeLabel } from '~/utils/labels'

// Plan, new session (design/plan.md)
const shell = useShell()
// The PM by its current name and picture
const pm = computed(() => shell.agents.find(a => a.role === 'pm') ?? null)
const router = useRouter()
const route = useRoute()
const pending = usePendingPlan()
const device = useDevice()
// The attached task and its epic open beside the composer, or over it on
// phones, which keeps the draft that going to the task's page would lose
provide(FLYOUT_SHEETS, true)
useSeoMeta({ title: 'Plan · Corral' })

const lastProject = useLocalStorage<string | null>('corral.plan.project', null)
const projectId = ref<string | null>(typeof route.query.project === 'string' ? route.query.project : lastProject.value)
const project = computed(() => shell.projects.find(p => p.id === projectId.value) ?? shell.projects[0] ?? null)
watch(project, (p) => {
  if (p) lastProject.value = p.id
}, { immediate: true })
// The PM's runtime for the new session (D18): only CLIs the runner has.
// Until the runner answers, Claude is the one on offer.
const { data: clis } = useQuery(computed(() => ({ ...clisQuery(), enabled: Boolean(shell.runner?.online) })))
const runtimes = computed(() => {
  const found = detectedRuntimes(clis.value ?? [])
  return found.length > 0 ? found : ['claude-code' as const]
})
const runtimeItems = computed(() => runtimes.value.map(r => ({ label: runtimeLabel(r), value: r })))
const lastRuntime = useLocalStorage<AgentRuntime>('corral.plan.runtime', 'claude-code')
const runtime = computed<AgentRuntime>(() => runtimes.value.includes(lastRuntime.value) ? lastRuntime.value : runtimes.value[0]!)
const restored = pending.restored.value
pending.restored.value = null
if (restored) {
  projectId.value = restored.session.projectId
  lastRuntime.value = restored.session.runtime
}
const restoredImages = [...(restored?.message ?? '').matchAll(/!\[([^\]]*)\]\(attachment:([^)]*)\)/g)].map(m => ({ name: m[1]!, id: m[2]! }))
const text = useDraft('plan:new')
if (restored) text.value = restored.message.replace(/!\[[^\]]*\]\(attachment:[^)]*\)/g, '').trim()
const composer = ref<{ send: (message: string) => Promise<void> } | null>(null)
const taskRef = ref<string | null>(restored?.taskRef ?? null)
const busy = ref(false)
const runnerOffline = computed(() => shell.loaded && !shell.runner?.online)
const reconnecting = ref(false)
// Re-reads the runner's status, in case its live update was missed
async function reconnect() {
  reconnecting.value = true
  try {
    await reloadShell()
  } finally {
    reconnecting.value = false
  }
}

const { tasks: projectTasks } = useProjectLists(() => project.value?.slug ?? '')
const backlog = computed(() => project.value ? projectTasks.value.filter(t => t.status === 'backlog') : [])
// The project's Drafts by session, kept current by plan.drafts, which
// follows every propose, approve and discard
const sessions = useQuery(planSessionsQuery()).data
const draftsQuery = useQuery(computed(() => ({ ...planDraftsQuery(project.value?.slug ?? ''), enabled: Boolean(project.value) })))
const drafts = computed(() => draftsQuery.data.value ?? [])
const placeholder = computed(() => {
  if (runnerOffline.value && device.isMobile.value) return `${pm.value?.name ?? 'The PM'} is unavailable while the runner is offline`
  return taskRef.value ? `What should change about ${taskRef.value}? (optional)` : 'Describe what you want to build…'
})
// Resolves false when not started, so the composer keeps its images
async function start(message: string): Promise<boolean> {
  if (!project.value) return false
  if (busy.value) return false
  busy.value = true
  const id = pending.seed(project.value.id, message, runtime.value, taskRef.value ?? undefined)
  usePlanThreads().add(id)
  text.value = ''
  await router.push(`/plan/${id}`)
  void pending.start(id)
  return true
}
</script>

<template>
  <UDashboardPanel>
    <div class="flex min-h-0 flex-1 max-[1100px]:flex-col">
      <div :class="['flex min-w-0 flex-1 flex-col items-center', device.isMobile.value ? 'shrink-0 justify-start p-4' : 'min-h-0 overflow-y-auto overscroll-contain p-6']">
        <!-- my-auto, not justify-center: a tall page must still scroll to its top -->
        <div :class="['flex w-full max-w-[720px] flex-col gap-6', !device.isMobile.value && 'my-auto']">
          <div class="flex flex-col items-center gap-2 text-center">
            <AgentAvatar
              :name="pm?.name ?? 'PM'"
              size="3xl"
            />
            <h1 class="text-2xl font-semibold">
              What should we plan?
            </h1>
          </div>

          <UAlert
            v-if="runnerOffline && device.isMobile.value"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Plan needs the runner. It's offline."
            :description="`${pm?.name ?? 'The PM'} runs in the runner container. Your sessions and drafts are safe.`"
            :actions="[{ label: 'Reconnect', color: 'error', variant: 'outline', loading: reconnecting, onClick: reconnect }]"
            data-testid="plan-runner-offline"
          />
          <UAlert
            v-else-if="runnerOffline"
            color="warning"
            variant="subtle"
            icon="i-lucide-server-off"
            title="Plan needs the runner. It's offline."
            description="Start the runner, then try again."
          />

          <PromptComposer
            ref="composer"
            v-model="text"
            :initial-images="restoredImages"
            :placeholder="placeholder"
            :disabled="runnerOffline || !project"
            :busy="busy"
            :allow-empty="taskRef !== null"
            :rows="3"
            :project="project?.slug"
            draft-key="plan:new"
            @submit="start"
          >
            <template #header>
              <div
                v-if="taskRef"
                class="flex items-center gap-2 text-xs"
              >
                <UBadge
                  variant="subtle"
                  color="primary"
                >
                  Refining <TaskLink
                    :task-ref="taskRef"
                    class="underline"
                  />
                </UBadge>
                <UButton
                  icon="i-lucide-x"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  aria-label="Remove attached task"
                  @click="taskRef = null"
                />
              </div>
            </template>
            <template #tools>
              <USelectMenu
                :model-value="project?.id"
                :items="shell.projects.map(p => ({ label: p.name, value: p.id, project: p }))"
                value-key="value"
                size="xs"
                variant="ghost"
                :search-input="false"
                aria-label="Project"
                :ui="{ content: 'w-80 max-w-[calc(100vw-2rem)]', base: 'max-w-56' }"
                @update:model-value="projectId = $event as string"
              >
                <template #item-leading="{ item }">
                  <ProjectThumbnail
                    :project="item.project"
                    :size="20"
                  />
                </template>
                <template #leading>
                  <span
                    class="size-2.5 rounded-full"
                    :style="{ background: project ? projectColor(project) : 'var(--ui-text-dimmed)' }"
                  />
                </template>
              </USelectMenu>
              <USelectMenu
                :model-value="runtime"
                :items="runtimeItems"
                value-key="value"
                size="xs"
                variant="ghost"
                icon="i-lucide-cpu"
                :search-input="false"
                aria-label="Runtime"
                data-testid="plan-runtime"
                :ui="{ content: 'w-48', base: 'max-w-40' }"
                @update:model-value="lastRuntime = $event as AgentRuntime"
              />
              <USelectMenu
                :model-value="taskRef ?? undefined"
                :items="backlog.map(t => ({ label: `${t.ref} ${t.title}`, value: t.ref }))"
                value-key="value"
                size="xs"
                variant="ghost"
                icon="i-lucide-list-checks"
                placeholder="Refine a task"
                :search-input="{ placeholder: 'Search Backlog' }"
                aria-label="Refine a task"
                :ui="{ content: 'w-80 max-w-[calc(100vw-2rem)]', base: 'max-w-56' }"
                @update:model-value="taskRef = ($event as string | null)"
              />
              <!-- First on phones, so it's in reach without scrolling the toolbar -->
              <PlanGrillButton
                :draft="text"
                :disabled="busy || runnerOffline || !project"
                :class="device.isMobile.value && 'order-first'"
                @send="composer?.send($event)"
              />
              <USelectMenu
                v-if="!device.isMobile.value"
                :items="(sessions ?? []).map(s => ({ label: s.title, value: s.id }))"
                value-key="value"
                size="xs"
                variant="ghost"
                icon="i-lucide-history"
                placeholder="Resume"
                :search-input="{ placeholder: 'Search sessions' }"
                aria-label="Resume a session"
                :ui="{ content: 'w-80 max-w-[calc(100vw-2rem)]', base: 'max-w-56' }"
                @update:model-value="$router.push(`/plan/${$event}`)"
              />
            </template>
          </PromptComposer>

          <p
            v-if="runnerOffline && device.isMobile.value"
            class="-mt-3 text-xs text-muted"
          >
            You can still read the Inbox, the board and past runs.
          </p>

          <PlanDrafts
            :sessions="drafts"
            :mobile="device.isMobile.value"
          />
        </div>
      </div>
      <PlanSheets
        v-if="device.isMobile.value"
        :plan="null"
        :previous="null"
        :busy="false"
      />
      <TaskFlyout v-else />
    </div>
  </UDashboardPanel>
</template>
