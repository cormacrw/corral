<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { FLYOUT_SHEETS } from '~/features/tasks/composables/useTaskFlyout'
import { STOP_ASKING } from '~/features/plan/utils/plan-questions'
import { usePlanActions } from '~/features/plan/composables/usePlanActions'
import { usePlanRunner } from '~/features/plan/composables/usePlanRunner'
import { usePlanSession } from '~/features/plan/composables/usePlanSession'
import { usePlanThreadScroll } from '~/features/plan/composables/usePlanThreadScroll'

// A Plan conversation (design/plan.md)
const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ read: [] }>()
provide(FLYOUT_SHEETS, true)
const router = useRouter()
const shell = useShell()
const flyout = useTaskFlyout()
const device = useDevice()
const id = () => props.sessionId

const state = usePlanSession(id, () => emit('read'))
const { pending, starting, detail, session, accepted, waitingForStart, error, latest, previous, activeRunId, liveEvents } = state
const { pm, offline } = usePlanRunner()
const { text, taskRef, busy, approving, cantApprove, cantSend, send, quick, approve } = usePlanActions(id, state, () => offline.value)
const pmName = computed(() => pm.value?.name ?? 'PM')
const project = computed(() => shell.projects.find(p => p.id === session.value?.projectId) ?? null)
const load = () => detail.refetch()
const composer = ref<{ focus: () => void } | null>(null)
useSeoMeta({ title: () => `${session.value?.title ?? 'Plan'} · Corral` })

async function backToPrompt() {
  if (!starting.value) return
  pending.restored.value = starting.value
  await router.push('/plan')
}

// Desktop opens a waiting plan on arrival; phones keep the conversation visible.
watch(() => latest.value?.id, (planId) => {
  if (!device.isMobile.value && planId && latest.value?.status === 'proposed' && !flyout.ref.value && !flyout.epic.value && !flyout.plan.value) flyout.openPlan({ replace: true })
}, { immediate: true })

const { log, content, onLogScroll } = usePlanThreadScroll(() => {
  const last = session.value?.messages.at(-1)
  return {
    threadId: session.value?.id,
    messageId: last?.id,
    human: last?.role === 'human',
    questionId: last?.kind === 'question' ? last.id : undefined,
    revision: liveEvents.value.length
  }
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
          v-if="session && accepted"
          :session="session"
          menu
        />
        <AppButton
          to="/plan"
          icon="i-ri-add-line"
          variant="ghost"
          color="neutral"
          aria-label="New session"
        />
      </template>
    </MobilePageHeader>
    <div class="flex min-h-0 flex-1 max-[1100px]:flex-col">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <PlanSessionHeader
          v-if="!device.isMobile.value"
          :session="session"
          :project="project"
          :closable="accepted"
        />
        <PlanRelatedThreads
          :session-id="props.sessionId"
          :parent-session-id="session?.parentSessionId"
        />
        <AppLoadError
          v-if="error && !session"
          :title="error"
          :retry="load"
          class="m-4 w-auto"
        />
        <div
          v-else-if="detail.isPending.value && !session"
          class="flex flex-col gap-3 p-6"
        >
          <UiSkeleton class="h-10 w-2/3" />
          <UiSkeleton class="h-24 w-full" />
        </div>
        <div
          v-else-if="session"
          ref="log"
          role="log"
          aria-live="polite"
          class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
          @scroll.passive="onLogScroll"
        >
          <div
            ref="content"
            class="mx-auto flex w-full max-w-[768px] flex-col gap-4"
          >
            <PlanMessages
              :session="session"
              :pm-name="pmName"
              :active-run-id="activeRunId"
              :latest="latest"
              :cant-send="cantSend"
              :refining="starting?.taskRef"
              :failed="starting?.state === 'failed'"
              @retry="send('Please continue.')"
              @resolved="load"
              @answer="quick"
              @other="composer?.focus()"
              @stop="quick(STOP_ASKING)"
            />
            <AppAlert
              v-if="starting?.state === 'failed'"
              color="error"
              title="Message not sent"
              :description="starting.error ?? undefined"
              :actions="[{ label: 'Retry', onClick: () => pending.start(props.sessionId) }, { label: 'Back to prompt', onClick: backToPrompt }]"
            />
            <PlanLiveTurn
              v-if="activeRunId || waitingForStart"
              :events="liveEvents"
              :pm-name="pmName"
              :working="project ? 'Reading the code, wiki and board…' : 'Checking the board…'"
            />
          </div>
        </div>

        <PlanPill
          v-if="device.isMobile.value && latest && !flyout.plan.value"
          :plan="latest"
          @open="flyout.openPlan()"
        />
        <PlanReplyComposer
          ref="composer"
          v-model:text="text"
          v-model:task-ref="taskRef"
          :session-id="props.sessionId"
          :session="session"
          :project="project"
          :busy="busy || approving !== null"
          :cant-send="cantSend"
          @send="send"
          @grill="quick($event, false)"
        />
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
