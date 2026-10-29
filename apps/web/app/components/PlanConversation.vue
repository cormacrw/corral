<script setup lang="ts">
import type { Plan, PlanMessage, PlanSessionDetail } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { projectColor, runtimeLabel } from '~/utils/labels'
import { approvePlan } from '~/utils/plan-approval'
import { answerTo, openQuestionId, STOP_ASKING } from '~/utils/plan-questions'
import { withoutMessages } from '~/utils/tool-steps'

// A Plan conversation (design/plan.md)
const props = defineProps<{ sessionId: string, inbox?: boolean }>()
const router = useRouter()
const live = useLive()
const threads = usePlanThreads()
// The PM by its current name and picture
const pm = computed(() => live.state.value.agents.find(a => a.role === 'pm') ?? null)
const flyout = useTaskFlyout()
const toast = useToast()
const device = useDevice()
const id = computed(() => props.sessionId)
const session = ref<PlanSessionDetail | null>(null)
const error = ref<string | null>(null)
const text = ref('')
const taskRef = ref<string | null>(null)
const busy = ref(false)
const approving = ref<string | null>(null)
const project = computed(() => live.state.value.projects.find(p => p.id === session.value?.projectId) ?? null)
const runnerOffline = computed(() => live.state.value.loaded && !live.state.value.runner?.online)
const reconnecting = ref(false)
// Re-reads the runner's status, in case its live update was missed
async function reconnect() {
  reconnecting.value = true
  try {
    await live.load()
  } finally {
    reconnecting.value = false
  }
}
useSeoMeta({ title: () => `${session.value?.title ?? 'Plan'} · Corral` })

async function load() {
  error.value = null
  try {
    session.value = await api.plan.session(id.value)
    if (session.value.unread) void api.plan.read(id.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
watch(id, () => void load(), { immediate: true })
onMounted(() => {
  const stop = live.subscribe((event) => {
    if (!session.value) return
    if (event.type === 'plan.message' && event.message.sessionId === session.value.id) {
      if (!session.value.messages.some(m => m.id === event.message.id)) session.value.messages.push(event.message)
    }
    if (event.type === 'plan.updated' && event.plan.sessionId === session.value.id) {
      const i = session.value.plans.findIndex(p => p.id === event.plan.id)
      if (i >= 0) session.value.plans.splice(i, 1, event.plan)
      else session.value.plans.push(event.plan)
    }
    if (event.type === 'plan.session' && event.session.id === session.value.id) {
      Object.assign(session.value, event.session)
    }
  })
  onBeforeUnmount(stop)
})

const planOf = (message: PlanMessage): Plan | null => session.value?.plans.find(p => p.id === message.planId) ?? null
// The flyout always shows the newest version; the chat only links to it
const latest = computed(() => session.value?.plans.reduce<Plan | null>((a, p) => !a || p.version > a.version ? p : a, null) ?? null)
const planTaskCount = computed(() => latest.value?.tasks.filter(task => task.change !== 'removed').length ?? 0)
const previous = computed(() => latest.value ? session.value?.plans.find(p => p.version === latest.value!.version - 1) ?? null : null)
// Desktop opens a waiting plan on arrival; phones keep the conversation visible.
watch(() => latest.value?.id, (planId) => {
  if (!device.isMobile.value && planId && latest.value?.status === 'proposed' && !flyout.ref.value && !flyout.epic.value && !flyout.plan.value) flyout.openPlan({ replace: true })
})
const backlog = computed(() => project.value ? (live.state.value.tasks[project.value.id] ?? []).filter(t => t.status === 'backlog') : [])

// Resolves false when not sent, so the composer keeps its images
async function send(message: string): Promise<boolean> {
  if (!session.value) return false
  busy.value = true
  try {
    await api.plan.message(session.value.id, message, taskRef.value ?? undefined)
    threads.add(session.value.id)
    text.value = ''
    taskRef.value = null
    return true
  } catch (e) {
    toast.add({ title: 'Could not send', description: e instanceof Error ? e.message : String(e), color: 'error' })
    return false
  } finally {
    busy.value = false
  }
}
// One-tap answers and Grill me send straight away. An answer leaves the
// draft and attached task alone; Grill me sends the draft.
const composer = ref<{ focus: () => void } | null>(null)
const openQuestion = computed(() => session.value ? openQuestionId(session.value.messages) : null)
const cantSend = computed(() => busy.value || runnerOffline.value || Boolean(session.value?.activeRunId))
async function quick(message: string, keepDraft = true) {
  const draft = text.value
  const task = taskRef.value
  if (keepDraft) taskRef.value = null
  const sent = await send(message)
  if (keepDraft) {
    taskRef.value = task
    if (sent) text.value = draft
  }
}
async function approve(plan: Plan, to: 'ready' | 'backlog') {
  approving.value = plan.id
  try {
    await approvePlan(plan, to, {
      approve: api.plan.approve,
      toast,
      mobile: device.isMobile.value,
      closeSheet: flyout.close,
      push: path => router.push(props.inbox ? '/inbox' : path)
    })
  } finally {
    approving.value = null
  }
}
// The PM's turn as it happens: the saved part, then live run.events
const activeRunId = computed(() => session.value?.activeRunId ?? null)
watch(activeRunId, async (runId) => {
  if (!runId) return
  live.watchRun(runId, [])
  try {
    const saved = await api.runs.transcript(runId)
    if (activeRunId.value === runId) live.watchRun(runId, saved)
  } catch {
    // The live events still arrive
  }
}, { immediate: true })
// What the turn has posted to the log already (a question, a plan) isn't repeated in its transcript
const repliesOf = (runId: string) => session.value?.messages.filter(m => m.role === 'pm' && m.runId === runId).map(m => m.text) ?? []
const liveEvents = computed(() => activeRunId.value ? withoutMessages(live.state.value.runEvents[activeRunId.value] ?? [], repliesOf(activeRunId.value)) : [])
// A finished turn's steps sit above its first message
const firstOfTurn = (message: PlanMessage) => message.role === 'pm' && message.runId !== null && message.runId !== activeRunId.value
  && session.value?.messages.find(m => m.role === 'pm' && m.runId === message.runId)?.id === message.id

// On phones the plan opens in a bottom sheet, and a task or epic from it
// in a taller one over it; closing either clears ?plan, ?task and ?epic.
// The drawers also report closing when the route closed them, so check first.
const planSheet = computed({
  get: () => flyout.plan.value && !flyout.ref.value && !flyout.epic.value,
  set: (open) => {
    if (!open && flyout.plan.value) flyout.close()
  }
})
const detailSheet = computed({
  get: () => Boolean(flyout.ref.value || flyout.epic.value),
  set: (open) => {
    if (!open && (flyout.ref.value || flyout.epic.value)) flyout.close()
  }
})

// Follows the conversation. When the PM's next question arrives it scrolls
// to the question's top, so a long one isn't cut off above its answers.
const log = ref<HTMLElement | null>(null)
watch(() => [session.value?.messages.length, liveEvents.value.length], async () => {
  await nextTick()
  if (!log.value) return
  const last = session.value?.messages.at(-1)
  const question = last?.kind === 'question' ? log.value.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`) : null
  log.value.scrollTop = question ? question.offsetTop - 16 : log.value.scrollHeight
})
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <!-- Phones switch sessions from the header (design/mobile.md) -->
    <Teleport
      v-if="device.isMobile.value"
      defer
      to="#mobile-header-actions"
    >
      <UButton
        v-if="props.inbox"
        :to="`/plan/${id}`"
        label="Open in Plan"
        variant="ghost"
        color="neutral"
      />
      <PlanSessionSwitcher v-else />
      <UButton
        v-if="!props.inbox"
        to="/plan"
        icon="i-lucide-plus"
        variant="ghost"
        color="neutral"
        aria-label="New session"
      />
    </Teleport>
    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <header
          v-if="!device.isMobile.value"
          class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4 text-sm"
        >
          <span
            v-if="project"
            class="size-2.5 rounded-full"
            :style="{ background: projectColor(project) }"
          />
          <span class="text-muted">{{ project?.name }}</span>
          <span class="truncate font-medium">{{ session?.title }}</span>
          <UBadge
            v-if="session"
            :label="runtimeLabel(session.runtime)"
            variant="subtle"
            color="neutral"
            size="sm"
            data-testid="plan-session-runtime"
          />
          <UButton
            to="/plan"
            label="New session"
            variant="ghost"
            color="neutral"
            size="sm"
            class="ms-auto"
          />
        </header>

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          class="m-4"
          :actions="[{ label: 'Retry', onClick: load }]"
        />
        <div
          v-else-if="!session"
          class="flex flex-col gap-3 p-6"
        >
          <USkeleton class="h-10 w-2/3" />
          <USkeleton class="h-24 w-full" />
        </div>
        <div
          v-else
          ref="log"
          role="log"
          aria-live="polite"
          class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
        >
          <div class="mx-auto flex w-full max-w-[768px] flex-col gap-4">
            <div
              v-for="message in session.messages"
              :key="message.id"
              :data-message-id="message.id"
              :class="['flex', message.role === 'human' ? 'justify-end' : 'justify-start']"
            >
              <div
                v-if="message.role === 'human'"
                class="max-w-[85%] min-w-0 rounded-lg bg-elevated px-3 py-2 text-sm"
              >
                <MarkdownText
                  :text="message.text"
                  breaks
                />
              </div>
              <!-- Full width on phones, so a question's answers span the screen -->
              <div
                v-else
                :class="['flex max-w-full min-w-0 gap-2', device.isMobile.value && 'flex-1']"
              >
                <AgentAvatar
                  :name="pm?.name ?? 'PM'"
                  size="sm"
                />
                <div :class="['flex min-w-0 flex-col gap-2', device.isMobile.value && 'flex-1']">
                  <span class="text-xs text-muted">{{ pm?.name ?? 'PM' }} · PM</span>
                  <PlanTurnSteps
                    v-if="firstOfTurn(message)"
                    :run-id="message.runId!"
                    :replies="repliesOf(message.runId!)"
                    :agent-name="pm?.name ?? 'PM'"
                  />
                  <UAlert
                    v-if="message.kind === 'error'"
                    color="error"
                    variant="subtle"
                    :title="message.text"
                    :actions="[{ label: 'Retry', onClick: () => send('Please continue.') }]"
                  />
                  <PlanQuestion
                    v-else-if="message.kind === 'question'"
                    :message="message"
                    :active="message.id === openQuestion"
                    :answer="answerTo(session.messages, message.id)"
                    :disabled="cantSend"
                    :stacked="device.isMobile.value"
                    @answer="quick"
                    @other="composer?.focus()"
                    @stop="quick(STOP_ASKING)"
                  />
                  <div
                    v-else
                    class="text-sm"
                  >
                    <MarkdownText :text="message.text" />
                  </div>
                  <button
                    v-if="planOf(message)"
                    type="button"
                    :class="['flex max-w-full items-center gap-2 self-start rounded-md border border-default px-3 py-2 text-start text-sm hover:bg-elevated', flyout.plan.value && 'bg-elevated']"
                    @click="flyout.plan.value ? flyout.close() : flyout.openPlan()"
                  >
                    <UIcon
                      name="i-lucide-list-checks"
                      class="size-4 shrink-0 text-muted"
                    />
                    <span class="min-w-0 truncate">
                      <span class="font-medium">Plan v{{ planOf(message)!.version }}</span> · {{ planOf(message)!.title }}
                    </span>
                    <span class="shrink-0 text-xs text-muted">{{ planOf(message)!.id === latest?.id ? 'Open plan' : `Now v${latest?.version}` }}</span>
                  </button>
                </div>
              </div>
            </div>
            <div
              v-if="activeRunId"
              class="flex max-w-full min-w-0 gap-2"
            >
              <AgentAvatar
                :name="pm?.name ?? 'PM'"
                size="sm"
              />
              <div class="flex min-w-0 flex-1 flex-col gap-2">
                <span class="text-xs text-muted">{{ pm?.name ?? 'PM' }} · PM</span>
                <RunTranscript
                  :events="liveEvents"
                  live
                  :agent-name="pm?.name ?? 'PM'"
                  working="Reading the code, wiki and board…"
                  inline
                />
              </div>
            </div>
          </div>
        </div>

        <!-- A reserved row outside the log keeps the pill clear of answers and the composer. -->
        <div
          v-if="device.isMobile.value && latest && !flyout.plan.value"
          class="flex shrink-0 justify-center px-3 py-2"
        >
          <UButton
            icon="i-lucide-list-checks"
            :color="latest.status === 'proposed' ? 'primary' : 'neutral'"
            variant="subtle"
            class="min-h-11 max-w-full rounded-full px-4 shadow-sm"
            data-testid="plan-pill"
            @click="flyout.openPlan()"
          >
            <span>Plan v{{ latest.version }} · {{ planTaskCount }} {{ planTaskCount === 1 ? 'task' : 'tasks' }}</span>
            <span
              v-if="latest.status === 'proposed'"
              class="text-xs"
            >Needs approval</span>
          </UButton>
        </div>

        <div :class="['shrink-0 border-t border-default p-3', device.isMobile.value && 'pb-[max(0.75rem,env(safe-area-inset-bottom))]']">
          <div class="mx-auto w-full max-w-[768px]">
            <UAlert
              v-if="runnerOffline && device.isMobile.value"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="Plan needs the runner. It's offline."
              :description="`${pm?.name ?? 'The PM'} runs in the runner container. Your sessions and drafts are safe.`"
              :actions="[{ label: 'Reconnect', color: 'error', variant: 'outline', loading: reconnecting, onClick: reconnect }]"
              class="mb-2"
              data-testid="plan-runner-offline"
            />
            <UAlert
              v-else-if="runnerOffline"
              color="warning"
              variant="subtle"
              icon="i-lucide-server-off"
              title="Plan needs the runner. It's offline."
              class="mb-2"
            />
            <UButton
              v-if="props.inbox && latest"
              label="View plan"
              variant="ghost"
              class="mb-2 min-h-11"
              @click="flyout.openPlan()"
            />
            <div
              v-if="props.inbox && latest?.status === 'proposed'"
              class="mb-2 flex min-w-0 gap-2"
            >
              <UButton
                class="min-h-11 min-w-0 flex-1 justify-center text-xs"
                label="Approve to board"
                :loading="approving !== null"
                @click="approve(latest, 'ready')"
              />
              <UButton
                class="min-h-11 min-w-0 flex-1 justify-center text-xs"
                label="Approve to Backlog"
                variant="outline"
                :loading="approving !== null"
                @click="approve(latest, 'backlog')"
              />
            </div>
            <PromptComposer
              ref="composer"
              v-model="text"
              :placeholder="runnerOffline && device.isMobile.value ? `${pm?.name ?? 'The PM'} is unavailable while the runner is offline` : `Reply to ${pm?.name ?? 'the PM'}…`"
              :disabled="runnerOffline || Boolean(session?.activeRunId)"
              :busy="busy"
              :allow-empty="taskRef !== null"
              :project="project?.slug"
              @submit="send"
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
                    Refining {{ taskRef }}
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
                <!-- Locked: an agent session only resumes on the vendor that made it (D18) -->
                <UTooltip
                  v-if="session"
                  text="A session keeps the runtime it started with"
                >
                  <UButton
                    :label="runtimeLabel(session.runtime)"
                    icon="i-lucide-lock"
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    disabled
                    aria-label="Runtime (locked)"
                    data-testid="plan-runtime-locked"
                  />
                </UTooltip>
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
                  :disabled="cantSend"
                  :class="device.isMobile.value && 'order-first'"
                  @send="quick($event, false)"
                />
              </template>
            </PromptComposer>
          </div>
        </div>
      </div>
      <template v-if="device.isMobile.value">
        <UDrawer
          v-model:open="planSheet"
          :title="latest ? `Plan v${latest.version}` : 'Plan'"
          :ui="{ content: 'h-[88svh]' }"
        >
          <template #content>
            <div
              v-if="latest"
              class="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]"
              data-testid="plan-sheet"
            >
              <PlanDetail
                class="flex-1"
                :plan="latest"
                :previous="previous"
                :busy="approving === latest.id"
                sheet
                @approve="approve(latest, $event)"
                @close="flyout.close()"
              />
            </div>
          </template>
        </UDrawer>
        <UDrawer
          v-model:open="detailSheet"
          :title="flyout.ref.value ? `Task ${flyout.ref.value}` : 'Epic'"
          :ui="{ content: 'h-[94svh]' }"
        >
          <template #content>
            <div class="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
              <TaskDetail
                v-if="flyout.ref.value"
                class="flex-1"
                :task-ref="flyout.ref.value"
                mode="flyout"
                @close="flyout.close()"
              />
              <EpicDetail
                v-else-if="flyout.epic.value"
                class="flex-1"
                :epic-id="flyout.epic.value"
                mode="flyout"
                @close="flyout.close()"
              />
            </div>
          </template>
        </UDrawer>
      </template>
      <TaskFlyout v-else>
        <template
          v-if="latest"
          #plan
        >
          <PlanDetail
            :plan="latest"
            :previous="previous"
            :busy="approving === latest.id"
            @approve="approve(latest, $event)"
            @close="flyout.close()"
          />
        </template>
      </TaskFlyout>
    </div>
  </UDashboardPanel>
</template>
