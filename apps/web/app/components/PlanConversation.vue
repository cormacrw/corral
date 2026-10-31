<script setup lang="ts">
import type { Plan, PlanMessage } from '@corral/contracts'
import { approvedPlanSummary } from '@corral/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { approvePlan as approvePlanMutation, planSessionQuery, markPlanRead, sendPlanMessage } from '~/queries/plan'
import { runTranscriptQuery } from '~/queries/runs'
import { reloadShell } from '~/queries/shell'
import { projectColor, runtimeLabel } from '~/utils/labels'
import { approvePlan } from '~/utils/plan-approval'
import { answerTo, openQuestionId, STOP_ASKING } from '~/utils/plan-questions'
import { withoutMessages } from '~/utils/tool-steps'

// A Plan conversation (design/plan.md)
const props = defineProps<{ sessionId: string, inbox?: boolean }>()
const emit = defineEmits<{ read: [], approved: [], approving: [value: boolean] }>()
const router = useRouter()
const live = useLive()
const threads = usePlanThreads()
// The PM by its current name and picture
const pm = computed(() => live.state.value.agents.find(a => a.role === 'pm') ?? null)
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
const text = ref('')
const taskRef = ref<string | null>(null)
const busy = ref(false)
const approving = ref<string | null>(null)
const approvalTarget = ref<'ready' | 'backlog' | null>(null)
const project = computed(() => live.state.value.projects.find(p => p.id === session.value?.projectId) ?? null)
const parent = computed(() => live.state.value.planSessions.find(s => s.id === session.value?.parentSessionId))
const children = computed(() => live.state.value.planSessions.filter(s => s.parentSessionId === id.value))
const runnerOffline = computed(() => live.state.value.loaded && !live.state.value.runner?.online)
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
useSeoMeta({ title: () => props.inbox ? 'Inbox · Corral' : `${session.value?.title ?? 'Plan'} · Corral` })

watch(id, () => {
  text.value = ''
  taskRef.value = null
  busy.value = false
  approving.value = null
  approvalTarget.value = null
})

const planOf = (message: PlanMessage): Plan | null => session.value?.plans.find(p => p.id === message.planId) ?? null
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
const openQuestion = computed(() => session.value ? openQuestionId(session.value.messages) : null)
const cantApprove = computed(() => Boolean(starting.value && (starting.value.state !== 'accepted' || waitingForStart.value)) || busy.value || approving.value !== null || Boolean(session.value?.activeRunId))
const cantSend = computed(() => cantApprove.value || runnerOffline.value)
async function submit(message: string): Promise<boolean> {
  if (props.inbox && approvalTarget.value && latest.value) return approve(latest.value, approvalTarget.value)
  return send(message)
}
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
  emit('approving', true)
  try {
    if (props.inbox) {
      const approved = await approval.mutateAsync({ planId: plan.id, to })
      toast.add({ title: 'Resolved', description: approvedPlanSummary(approved.tasks), color: 'success' })
      await flyout.close()
      emit('approved')
      return true
    }
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
    if (id.value === approvingIn) {
      approving.value = null
      emit('approving', false)
    }
  }
}
// The PM's turn as it happens: the saved part, then live run.events
const activeRunId = computed(() => session.value?.activeRunId ?? null)
const transcript = useQuery(computed(() => ({ ...runTranscriptQuery(activeRunId.value ?? ''), enabled: Boolean(activeRunId.value) })))
// What the turn has posted to the log already (a question, a plan) isn't repeated in its transcript
const repliesOf = (runId: string) => session.value?.messages.filter(m => m.role === 'pm' && m.runId === runId).map(m => m.text) ?? []
const liveEvents = computed(() => activeRunId.value ? withoutMessages(transcript.data.value ?? [], repliesOf(activeRunId.value)) : [])
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
watch([() => session.value?.id, () => session.value?.messages.length, () => liveEvents.value.length], async () => {
  await nextTick()
  if (!log.value) return
  const last = session.value?.messages.at(-1)
  const question = last?.kind === 'question' ? log.value.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`) : null
  log.value.scrollTop = question ? question.offsetTop - 16 : log.value.scrollHeight
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
        <PlanSessionSwitcher v-if="!props.inbox" />
        <UButton
          v-if="props.inbox"
          :to="`/plan/${id}`"
          label="Open in Plan"
          variant="ghost"
          color="neutral"
        />
        <PlanCloseThread
          v-if="session && (!starting || starting.state === 'accepted')"
          :session="session"
          menu
        />
        <UButton
          v-if="!props.inbox"
          to="/plan"
          icon="i-lucide-plus"
          variant="ghost"
          color="neutral"
          aria-label="New session"
        />
      </template>
    </MobilePageHeader>
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
          <span class="text-muted">{{ project?.name ?? 'Global' }}</span>
          <span class="truncate font-medium">{{ session?.title }}</span>
          <UBadge
            v-if="session"
            :label="runtimeLabel(session.runtime)"
            variant="subtle"
            color="neutral"
            size="sm"
            data-testid="plan-session-runtime"
          />
          <UBadge
            v-if="inbox && session && session.status !== 'none'"
            :label="session.status === 'needs_approval' ? 'Needs approval' : 'Question'"
            :color="session.status === 'needs_approval' ? 'primary' : 'info'"
            variant="subtle"
            size="xs"
          />
          <div class="ms-auto flex shrink-0 items-center gap-2">
            <PlanCloseThread
              v-if="session && (!starting || starting.state === 'accepted')"
              :session="session"
            />
            <UButton
              :to="inbox ? `/plan/${id}` : '/plan'"
              :label="inbox ? 'Open in Plan' : 'New session'"
              variant="ghost"
              color="neutral"
              size="sm"
            />
          </div>
        </header>

        <nav
          v-if="parent || children.length"
          aria-label="Related threads"
          class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-default px-4 py-2 text-sm"
        >
          <NuxtLink
            v-if="parent"
            :to="`/plan/${parent.id}`"
            class="text-primary hover:underline"
          >Parent: {{ parent.title }}</NuxtLink>
          <span
            v-if="children.length"
            class="text-muted"
          >Child threads:</span>
          <NuxtLink
            v-for="child in children"
            :key="child.id"
            :to="`/plan/${child.id}`"
            class="text-primary hover:underline"
          >{{ child.title }}{{ child.closed ? ' (closed)' : '' }}</NuxtLink>
        </nav>
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
                <UBadge
                  v-if="starting?.taskRef && message.id === session.messages[0]?.id"
                  variant="subtle"
                  class="mt-2"
                >
                  Refining {{ starting.taskRef }}
                </UBadge>
                <span
                  v-if="starting?.state === 'failed' && message.id.startsWith('pending-')"
                  class="block text-xs text-error"
                >Not sent</span>
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
                  <NuxtLink
                    v-if="message.role === 'thread' && message.senderSessionId"
                    :to="`/plan/${message.senderSessionId}`"
                    class="text-xs text-primary hover:underline"
                  >{{ message.senderTitle ?? 'Removed thread' }} · Thread{{ message.kind === 'notification' ? ' notification' : '' }}</NuxtLink>
                  <span
                    v-else
                    class="text-xs text-muted"
                  >{{ message.role === 'thread' ? `${message.senderTitle ?? 'Removed thread'} · Thread` : `${pm?.name ?? 'PM'} · PM` }}</span>
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
                  <PlanConfirmAction
                    v-else-if="message.pendingAction"
                    :message="message"
                    @resolved="load"
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
                  :working="project ? 'Reading the code, wiki and board…' : 'Checking the board…'"
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
            <!-- Phones view the plan in a sheet and approve with one tap (design/inbox.md) -->
            <template v-if="inbox && device.isMobile.value">
              <UButton
                v-if="latest"
                label="View plan"
                variant="ghost"
                class="mb-2 min-h-11"
                @click="flyout.openPlan()"
              />
              <div
                v-if="latest?.status === 'proposed'"
                class="mb-2 flex min-w-0 gap-2"
              >
                <UButton
                  class="min-h-11 min-w-0 flex-1 justify-center text-xs"
                  label="Approve to board"
                  :loading="approving !== null"
                  :disabled="cantApprove"
                  @click="approve(latest, 'ready')"
                />
                <UButton
                  class="min-h-11 min-w-0 flex-1 justify-center text-xs"
                  label="Approve to Backlog"
                  variant="outline"
                  :loading="approving !== null"
                  :disabled="cantApprove"
                  @click="approve(latest, 'backlog')"
                />
              </div>
            </template>
            <div
              v-else-if="inbox && latest?.status === 'proposed'"
              role="radiogroup"
              aria-label="Plan actions"
              class="mb-2 flex flex-wrap gap-2"
            >
              <UButton
                label="Approve to board"
                size="sm"
                role="radio"
                :aria-checked="approvalTarget === 'ready'"
                :variant="approvalTarget === 'ready' ? 'subtle' : 'outline'"
                :disabled="cantApprove"
                @click="approvalTarget = approvalTarget === 'ready' ? null : 'ready'"
              />
              <UButton
                label="Approve to Backlog"
                role="radio"
                :aria-checked="approvalTarget === 'backlog'"
                :variant="approvalTarget === 'backlog' ? 'subtle' : 'outline'"
                size="sm"
                :disabled="cantApprove"
                @click="approvalTarget = approvalTarget === 'backlog' ? null : 'backlog'"
              />
            </div>
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
              :submit-label="inbox && approvalTarget ? approvalTarget === 'ready' ? 'Approve to board' : 'Approve to Backlog' : ''"
              :allow-empty="taskRef !== null || (inbox && approvalTarget !== null)"
              :project="project?.slug"
              @submit="submit"
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
                  v-if="project"
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
  </div>
</template>
