<script setup lang="ts">
import type { Plan, PlanThreadItem } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { runtimeLabel } from '~/utils/labels'
import { approvedMessage } from '~/utils/plan-approval'
import { STOP_ASKING } from '~/utils/plan-questions'

// A Plan thread in the Inbox (design/inbox.md#detail-pane): only what needs
// you, the question or the plan, never the conversation. The full
// conversation is one click away with Open in Plan.
const props = defineProps<{ item: PlanThreadItem }>()
const emit = defineEmits<{ read: [], approved: [], approving: [value: boolean], closed: [], closing: [value: boolean] }>()
const live = useLive()
const flyout = useTaskFlyout()
const toast = useToast()
const threads = usePlanThreads()
const pm = computed(() => live.state.value.agents.find(a => a.role === 'pm') ?? null)
const pmName = computed(() => pm.value?.name ?? 'Juno')
const runnerOffline = computed(() => live.state.value.loaded && !live.state.value.runner?.online)

// The plan itself, for View plan and approving; the item only has its summary
const plans = ref<Plan[]>([])
async function loadPlans() {
  const requested = props.item.sessionId
  try {
    const session = await api.plan.session(requested)
    if (requested !== props.item.sessionId) return
    plans.value = session.plans
    if (session.unread) {
      await api.plan.read(requested)
      emit('read')
    }
  } catch {
    // The summary still shows; View plan waits for the next update
  }
}
watch(() => props.item.sessionId, () => {
  plans.value = []
  void loadPlans()
}, { immediate: true })
onMounted(() => {
  const stop = live.subscribe((event) => {
    // A reply arriving while the thread is open has been seen
    if (event.type === 'plan.session' && event.session.id === props.item.sessionId && event.session.unread) {
      void api.plan.read(props.item.sessionId).then(() => emit('read'))
    }
    if (event.type !== 'plan.updated' || event.plan.sessionId !== props.item.sessionId) return
    const i = plans.value.findIndex(p => p.id === event.plan.id)
    if (i >= 0) plans.value.splice(i, 1, event.plan)
    else plans.value.push(event.plan)
  })
  onBeforeUnmount(stop)
})
const plan = computed(() => props.item.plan ? plans.value.find(p => p.id === props.item.plan!.id) ?? null : null)
const previous = computed(() => plan.value ? plans.value.find(p => p.version === plan.value!.version - 1) ?? null : null)
const counts = computed(() => {
  const p = props.item.plan
  if (!p) return ''
  return `Plan v${p.version} · ${p.epicCount} ${p.epicCount === 1 ? 'epic' : 'epics'} · ${p.taskCount} ${p.taskCount === 1 ? 'task' : 'tasks'}`
})

// Answering starts a PM turn, as in Plan. The thread leaves Needs you while
// it runs, so this pane shows Juno working until Juno asks again or proposes.
const text = ref('')
const busy = ref(false)
const sent = ref(false)
watch(() => [props.item.question?.text, props.item.plan?.id, props.item.reply], () => {
  sent.value = false
})
const working = computed(() => sent.value || Boolean(props.item.activeRunId))
const cantSend = computed(() => busy.value || working.value || runnerOffline.value)
const composer = ref<{ focus: () => void } | null>(null)
async function send(message: string): Promise<boolean> {
  if (cantSend.value) return false
  busy.value = true
  try {
    await api.plan.message(props.item.sessionId, message)
    threads.add(props.item.sessionId)
    sent.value = true
    text.value = ''
    return true
  } catch (e) {
    toast.add({ title: 'Could not send', description: e instanceof Error ? e.message : String(e), color: 'error' })
    return false
  } finally {
    busy.value = false
  }
}

const approving = ref<'ready' | 'backlog' | null>(null)
async function approve(to: 'ready' | 'backlog') {
  if (!props.item.plan || approving.value || working.value) return
  approving.value = to
  emit('approving', true)
  try {
    const approved = await api.plan.approve(props.item.plan.id, to)
    toast.add({ title: 'Resolved', description: approvedMessage(approved, to), color: 'success' })
    await flyout.close()
    emit('approved')
  } catch (e) {
    toast.add({ title: 'Could not approve', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    approving.value = null
    emit('approving', false)
  }
}

// Close thread discards the drafts and the unapproved plan (design/inbox.md#close-thread)
const confirmClose = ref(false)
const closing = ref(false)
const closeError = ref<string | null>(null)
async function close() {
  closing.value = true
  emit('closing', true)
  closeError.value = null
  try {
    await api.plan.close(props.item.sessionId)
    threads.remove(props.item.sessionId)
    confirmClose.value = false
    await flyout.close()
    emit('closed')
  } catch (e) {
    confirmClose.value = false
    closeError.value = e instanceof Error ? e.message : String(e)
  } finally {
    closing.value = false
    emit('closing', false)
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-1">
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4 text-sm">
        <ProjectThumbnail
          :project="item.project"
          :size="20"
        />
        <span class="shrink-0 text-muted">{{ item.project.name }}</span>
        <h1 class="truncate font-medium">
          {{ item.subject }}
        </h1>
        <UBadge
          v-if="item.status !== 'none'"
          :label="item.status === 'needs_approval' ? 'Needs approval' : 'Question'"
          :color="item.status === 'needs_approval' ? 'primary' : 'info'"
          variant="subtle"
          size="xs"
        />
        <UBadge
          :label="runtimeLabel(item.runtime)"
          variant="subtle"
          color="neutral"
          size="sm"
        />
        <UButton
          :to="`/plan/${item.sessionId}`"
          label="Open in Plan"
          variant="ghost"
          color="neutral"
          size="sm"
          class="ms-auto"
        />
        <UButton
          label="Close thread"
          icon="i-lucide-archive-x"
          variant="ghost"
          color="error"
          size="sm"
          @click="confirmClose = true"
        />
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <div class="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          <UAlert
            v-if="closeError"
            color="error"
            variant="subtle"
            title="Could not close the thread"
            :description="closeError"
          />
          <div class="flex items-center gap-2 text-xs text-muted">
            <AgentAvatar
              :name="pmName"
              size="xs"
            />
            <span>{{ pmName }} · PM</span>
          </div>

          <template v-if="item.question">
            <PlanQuestion
              :message="item.question"
              :active="!working"
              :disabled="cantSend"
              @answer="send"
              @other="composer?.focus()"
              @stop="send(STOP_ASKING)"
            />
          </template>

          <section
            v-else-if="item.plan"
            class="flex flex-col gap-3 rounded-md border border-default p-4"
            data-testid="inbox-plan"
          >
            <span class="text-xs font-medium text-muted">{{ counts }}</span>
            <h2 class="text-base font-semibold">
              {{ item.plan.title }}
            </h2>
            <MarkdownText
              :text="item.plan.summary"
              class="text-sm"
            />
            <div class="flex flex-wrap gap-2">
              <UButton
                label="View plan"
                icon="i-lucide-list-checks"
                variant="outline"
                color="neutral"
                size="sm"
                :aria-pressed="flyout.plan.value"
                @click="flyout.plan.value ? flyout.close() : flyout.openPlan()"
              />
              <UButton
                label="Approve to board"
                size="sm"
                :loading="approving === 'ready'"
                :disabled="approving !== null || working"
                @click="approve('ready')"
              />
              <UButton
                label="Approve to Backlog"
                variant="outline"
                size="sm"
                :loading="approving === 'backlog'"
                :disabled="approving !== null || working"
                @click="approve('backlog')"
              />
              <UButton
                :to="`/plan/${item.sessionId}`"
                label="Open in Plan"
                variant="ghost"
                color="neutral"
                size="sm"
              />
            </div>
          </section>

          <MarkdownText
            v-else-if="item.reply"
            :text="item.reply"
            class="text-sm"
          />

          <div
            v-if="working"
            class="flex items-center gap-2 text-sm text-muted"
            data-testid="inbox-plan-working"
          >
            <UIcon
              name="i-lucide-loader-circle"
              class="size-4 animate-spin"
            />
            {{ pmName }} is working on it.
          </div>
        </div>
      </div>

      <div
        v-if="!item.plan"
        class="shrink-0 border-t border-default p-3"
      >
        <div class="mx-auto w-full max-w-[720px]">
          <UAlert
            v-if="runnerOffline"
            color="warning"
            variant="subtle"
            icon="i-lucide-server-off"
            title="Plan needs the runner. It's offline."
            class="mb-2"
          />
          <PromptComposer
            ref="composer"
            v-model="text"
            :placeholder="`Reply to ${pmName}…`"
            :disabled="runnerOffline || working"
            :busy="busy"
            :project="item.project.slug"
            @submit="send"
          />
        </div>
      </div>
    </div>

    <TaskFlyout>
      <template
        v-if="plan"
        #plan
      >
        <PlanDetail
          :plan="plan"
          :previous="previous"
          :busy="approving !== null"
          @approve="approve"
          @close="flyout.close()"
        />
      </template>
    </TaskFlyout>

    <UModal
      v-model:open="confirmClose"
      title="Close this thread?"
      :description="`${pmName}'s draft tasks and the unapproved plan will be discarded. You can reopen the thread later by sending it a message from Plan.${item.activeRunId ? ` ${pmName}'s current turn will be stopped.` : ''}`"
    >
      <template #footer>
        <UButton
          label="Cancel"
          variant="outline"
          color="neutral"
          @click="confirmClose = false"
        />
        <UButton
          label="Close thread"
          color="error"
          :loading="closing"
          @click="close"
        />
      </template>
    </UModal>
  </div>
</template>
