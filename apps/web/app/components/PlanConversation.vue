<script setup lang="ts">
import type { Plan } from '@corral/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { approvePlan as approvePlanMutation, planSessionQuery, markPlanRead, sendPlanMessage } from '~/queries/plan'
import { runTranscriptQuery } from '~/queries/runs'
import { reloadShell } from '~/queries/shell'
import { useDraft, writeDraft } from '~/composables/useDraft'
import { projectColor, runtimeLabel } from '~/utils/labels'
import { approvePlan } from '~/utils/plan-approval'
import { STOP_ASKING } from '~/utils/plan-questions'
import { withoutMessages } from '~/utils/tool-steps'
import PlanMessages from './PlanMessages.vue'

// A Plan conversation (design/plan.md)
const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ read: [] }>()
const router = useRouter()
const shell = useShell()
const threads = usePlanThreads()
// The PM by its current name and picture
const pm = computed(() => shell.agents.find(a => a.role === 'pm') ?? null)
const flyout = useTaskFlyout()
const toast = useToast()
const device = useDevice()
const id = computed(() => props.sessionId)
const pending = usePendingPlan()
const starting = computed(() => pending.entries.value[id.value])
const client = useQueryClient()
const sending = useMutation(sendPlanMessage)
const approval = useMutation(approvePlanMutation)
const detail = useQuery(computed(() => ({
  ...planSessionQuery(id.value),
  enabled: !starting.value || starting.value.state === 'accepted'
})))
const session = computed(() => starting.value && starting.value.state !== 'accepted' ? starting.value.session : detail.data.value ?? starting.value?.session ?? null)
watch(() => session.value?.unread, (unread) => {
  if (unread) {
    markPlanRead(client, id.value)
    emit('read')
  }
}, { immediate: true })
const waitingForStart = computed(() => Boolean(starting.value && starting.value.state !== 'failed' && !session.value?.activeRunId && !session.value?.messages.some(m => m.role === 'pm')))
async function backToPrompt() {
  if (!starting.value) return
  pending.restored.value = starting.value
  await router.push('/plan')
}
const error = computed(() => detail.error.value?.message ?? null)
const load = () => detail.refetch()
const text = useDraft(() => `plan:${props.sessionId}`)
const taskRef = ref<string | null>(null)
const busy = ref(false)
const approving = ref<string | null>(null)
const project = computed(() => shell.projects.find(p => p.id === session.value?.projectId) ?? null)
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
useSeoMeta({ title: () => `${session.value?.title ?? 'Plan'} · Corral` })

watch(id, () => {
  taskRef.value = null
  busy.value = false
  approving.value = null
})

// The flyout always shows the newest version; the chat only links to it
const latest = computed(() => session.value?.plans.reduce<Plan | null>((a, p) => !a || p.version > a.version ? p : a, null) ?? null)
const planTaskCount = computed(() => latest.value?.tasks.filter(task => task.change !== 'removed').length ?? 0)
const previous = computed(() => latest.value ? session.value?.plans.find(p => p.version === latest.value!.version - 1) ?? null : null)
// Desktop opens a waiting plan on arrival; phones keep the conversation visible.
watch(() => latest.value?.id, (planId) => {
  if (!device.isMobile.value && planId && latest.value?.status === 'proposed' && !flyout.ref.value && !flyout.epic.value && !flyout.plan.value) flyout.openPlan({ replace: true })
}, { immediate: true })
const { tasks: projectTasks } = useProjectLists(() => project.value?.slug ?? '')
const backlog = computed(() => project.value ? projectTasks.value.filter(t => t.status === 'backlog') : [])

// Resolves false when not sent, so the composer keeps its images
async function send(message: string): Promise<boolean> {
  if (!session.value || cantSend.value) return false
  const sendingTo = session.value.id
  busy.value = true
  try {
    await sending.mutateAsync({ id: sendingTo, text: message, taskRef: taskRef.value ?? undefined })
    threads.add(sendingTo)
    writeDraft(`plan:${sendingTo}`, '')
    if (session.value?.id === sendingTo) {
      text.value = ''
      taskRef.value = null
    }
    return true
  } catch (e) {
    toast.add({ title: 'Could not send', description: e instanceof Error ? e.message : String(e), color: 'error' })
    return false
  } finally {
    if (id.value === sendingTo) busy.value = false
  }
}
// One-tap answers and Grill me send straight away. An answer leaves the
// draft and attached task alone; Grill me sends the draft.
const composer = ref<{ focus: () => void } | null>(null)
const cantApprove = computed(() => Boolean(starting.value && (starting.value.state !== 'accepted' || waitingForStart.value)) || busy.value || approving.value !== null || Boolean(session.value?.activeRunId))
const cantSend = computed(() => cantApprove.value || runnerOffline.value)
async function quick(message: string, keepDraft = true) {
  const sendingTo = id.value
  const draft = text.value
  const task = taskRef.value
  if (keepDraft) taskRef.value = null
  const sent = await send(message)
  if (keepDraft && id.value === sendingTo) {
    taskRef.value = task
    if (sent) text.value = draft
  }
}
async function approve(plan: Plan, to: 'ready' | 'backlog') {
  if (cantApprove.value) return false
  const approvingIn = id.value
  approving.value = plan.id
  try {
    return await approvePlan(plan, to, {
      approve: (planId, to) => approval.mutateAsync({ planId, to }),
      toast,
      mobile: device.isMobile.value,
      closeSheet: flyout.close,
      push: path => router.push(path)
    })
  } catch (e) {
    toast.add({ title: 'Could not approve', description: e instanceof Error ? e.message : String(e), color: 'error' })
    return false
  } finally {
    if (id.value === approvingIn) approving.value = null
  }
}
// The PM's turn as it happens: the saved part, then live run.events
const activeRunId = computed(() => session.value?.activeRunId ?? null)
const transcript = useQuery(computed(() => ({ ...runTranscriptQuery(activeRunId.value ?? ''), enabled: Boolean(activeRunId.value) })))
// What the turn has posted to the log already (a question, a plan) isn't repeated in its transcript
const repliesOf = (runId: string) => session.value?.messages.filter(m => m.role === 'pm' && m.runId === runId).map(m => m.text) ?? []
const liveEvents = computed(() => activeRunId.value ? withoutMessages(transcript.data.value ?? [], repliesOf(activeRunId.value)) : [])

// Follows the conversation. When the PM's next question arrives it scrolls
// to the question's top, so a long one isn't cut off above its answers.
// A reader who has scrolled up stays there, until the conversation changes or
// they send something.
const log = ref<HTMLElement | null>(null)
const NEAR_BOTTOM_PX = 64
let following = true
function onLogScroll() {
  const el = log.value
  if (el) following = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
}
watch([() => session.value?.id, () => session.value?.messages.length, () => liveEvents.value.length], async ([sessionId, count], [lastSession, lastCount]) => {
  const last = session.value?.messages.at(-1)
  if (sessionId !== lastSession || (count !== lastCount && last?.role === 'human')) following = true
  await nextTick()
  if (!log.value) return
  const question = last?.kind === 'question' ? log.value.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`) : null
  if (question) log.value.scrollTop = question.offsetTop - 16
  else if (following) log.value.scrollTop = log.value.scrollHeight
})
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
    <!-- Focused mobile conversations keep their compact header. -->
    <MobilePageHeader
      v-if="device.isMobile.value"
      compact
    >
      <template #actions>
        <PlanSessionSwitcher />
        <PlanCloseThread
          v-if="session && (!starting || starting.state === 'accepted')"
          :session="session"
          menu
        />
        <UButton
          to="/plan"
          icon="i-lucide-plus"
          variant="ghost"
          color="neutral"
          aria-label="New session"
        />
      </template>
    </MobilePageHeader>
    <div class="flex min-h-0 flex-1 max-[1100px]:flex-col">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          v-if="!device.isMobile.value"
          class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4 text-sm"
        >
          <span
            v-if="project"
            class="size-2.5 shrink-0 rounded-full"
            :style="{ background: projectColor(project) }"
          />
          <span class="max-w-48 shrink-0 truncate text-muted">{{ project?.name }}</span>
          <span class="truncate font-medium">{{ session?.title }}</span>
          <UBadge
            v-if="session"
            :label="runtimeLabel(session.runtime)"
            variant="subtle"
            color="neutral"
            size="sm"
            data-testid="plan-session-runtime"
          />
          <div class="ms-auto flex shrink-0 items-center gap-2">
            <PlanCloseThread
              v-if="session && (!starting || starting.state === 'accepted')"
              :session="session"
            />
            <UButton
              to="/plan"
              label="New session"
              variant="ghost"
              color="neutral"
              size="sm"
            />
          </div>
        </header>

        <UAlert
          v-if="error && !session"
          color="error"
          variant="subtle"
          :title="error"
          class="m-4"
          :actions="[{ label: 'Retry', onClick: load }]"
        />
        <div
          v-else-if="detail.isPending.value && !session"
          class="flex flex-col gap-3 p-6"
        >
          <USkeleton class="h-10 w-2/3" />
          <USkeleton class="h-24 w-full" />
        </div>
        <div
          v-else-if="session"
          ref="log"
          role="log"
          aria-live="polite"
          class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
          @scroll.passive="onLogScroll"
        >
          <div class="mx-auto flex w-full max-w-[768px] flex-col gap-4">
            <PlanMessages
              :session="session"
              :pm-name="pm?.name ?? 'PM'"
              :active-run-id="activeRunId"
              :latest="latest"
              :cant-send="cantSend"
              :refining="starting?.taskRef"
              :failed="starting?.state === 'failed'"
              @retry="send('Please continue.')"
              @answer="quick"
              @other="composer?.focus()"
              @stop="quick(STOP_ASKING)"
            />
            <UAlert
              v-if="starting?.state === 'failed'"
              color="error"
              title="Message not sent"
              :description="starting.error ?? undefined"
              :actions="[{ label: 'Retry', onClick: () => pending.start(id) }, { label: 'Back to prompt', onClick: backToPrompt }]"
            />
            <div
              v-if="activeRunId || waitingForStart"
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
            <PromptComposer
              :key="id"
              ref="composer"
              v-model="text"
              :placeholder="runnerOffline && device.isMobile.value ? `${pm?.name ?? 'The PM'} is unavailable while the runner is offline` : `Reply to ${pm?.name ?? 'the PM'}…`"
              :disabled="runnerOffline || Boolean(session?.activeRunId)"
              :busy="busy || approving !== null"
              :allow-empty="taskRef !== null"
              :project="project?.slug"
              :draft-key="`plan:${id}`"
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
      <PlanSheets
        v-if="device.isMobile.value"
        :plan="latest"
        :previous="previous"
        :busy="approving !== null"
        :disabled="cantApprove"
        @approve="latest && approve(latest, $event)"
      />
      <TaskFlyout v-else>
        <template
          v-if="latest"
          #plan
        >
          <PlanDetail
            :plan="latest"
            :previous="previous"
            :busy="approving === latest.id"
            :disabled="cantApprove"
            @approve="approve(latest, $event)"
            @close="flyout.close()"
          />
        </template>
      </TaskFlyout>
    </div>
  </div>
</template>
