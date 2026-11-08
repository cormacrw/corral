<script setup lang="ts">
import { planPath } from '~/utils/routes'
import { computed, ref, watch } from 'vue'
import { useElementSize } from '@vueuse/core'
import { provideFlyoutHost } from '~/composables/useTaskFlyout'
import { STOP_ASKING } from '~/features/plan/utils/plan-questions'
import { usePlanThread } from '~/features/plan/composables/usePlanThread'
import { useRestoredStart } from '~/features/plan/composables/usePlanStart'
import { usePlanThreadScroll } from '~/features/plan/composables/usePlanThreadScroll'

// A Plan conversation (design/plan.md)
const props = defineProps<{ sessionId: string }>()
const router = useRouter()
const shell = useShell()
const flyout = useTaskFlyout()
const device = useDevice()
provideFlyoutHost({ sheets: true, docked: () => !device.isMobile.value })
const id = () => props.sessionId

// A phone goes to a new thread once a plan is approved, so the next request
// is a tap away; desktop stays on the session
const { pending, starting, detail, session, accepted, waitingForStart, error, latest, previous, activeRunId, liveEvents, pm, text, taskRef, busy, approving, cantApprove, cantSend, send, quick, approve }
  = usePlanThread(id, { moveOn: () => device.isMobile.value ? () => router.push(planPath()) : null })
const restored = useRestoredStart()
const pmName = computed(() => pm.value?.name ?? 'PM')
const project = computed(() => shell.projects.find(p => p.id === session.value?.projectId) ?? null)
const load = () => detail.refetch()
const composer = ref<{ focus: () => void } | null>(null)
useSeoMeta({ title: () => `${session.value?.title ?? 'Plan'} · Corral` })

async function backToPrompt() {
  if (!starting.value) return
  restored.value = starting.value
  await router.push(planPath())
}

// Desktop floats the latest plan beside the thread when the column has room
// for both (.corral/wiki/plan-beside-thread.md): the card's 340px and its
// margins, next to a thread of at least 480px. Narrower, the plan opens in
// the flyout as before. Phones keep the pill and sheets.
const column = ref<HTMLElement | null>(null)
const { width: columnWidth } = useElementSize(column)
const BESIDE = 364 // the card, its 24px gap and 16px right margin, less the log's 16px padding
const beside = computed(() => !device.isMobile.value && Boolean(latest.value) && columnWidth.value >= 32 + 480 + BESIDE)
// The thread stays centred while the card fits to its right, then moves left
const threadStyle = computed(() => beside.value ? { marginInline: `auto max(${BESIDE}px, calc((100% - 768px) / 2))` } : undefined)
const card = ref<HTMLElement | null>(null)

// Narrow desktop opens a waiting plan in the flyout on arrival, once the
// column is measured; phones keep the conversation visible.
watch([() => latest.value?.id, () => columnWidth.value > 0], ([planId, measured]) => {
  if (device.isMobile.value || !measured || beside.value) return
  if (planId && latest.value?.status === 'proposed' && !flyout.ref.value && !flyout.epic.value && !flyout.plan.value) flyout.openPlan({ replace: true })
}, { immediate: true })
// A ?plan link opens the page with the card showing instead of the flyout
watch([beside, flyout.plan], ([shown, inFlyout]) => {
  if (shown && inFlyout) void flyout.close()
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
        <PlanCloseThread
          v-if="session && accepted"
          :session="session"
          menu
        />
        <AppButton
          :to="planPath()"
          icon="i-hugeicons-add-01"
          variant="ghost"
          color="neutral"
          aria-label="New session"
        />
      </template>
    </MobilePageHeader>
    <div class="flex min-h-0 flex-1 max-[1100px]:flex-col">
      <div
        ref="column"
        class="flex min-h-0 min-w-0 flex-1 flex-col"
      >
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
          class="relative flex min-h-0 flex-1 flex-col"
        >
          <div
            ref="log"
            role="log"
            aria-live="polite"
            class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
            @scroll.passive="onLogScroll"
          >
            <div
              ref="content"
              :class="['flex max-w-[768px] flex-col gap-4', !beside && 'mx-auto w-full']"
              :style="threadStyle"
            >
              <PlanMessages
                :session="session"
                :pm-name="pmName"
                :active-run-id="activeRunId"
                :latest="latest"
                :cant-send="cantSend"
                :refining="starting?.taskRef"
                :failed="starting?.state === 'failed'"
                :plan-beside="beside"
                @show-plan="card?.focus()"
                @retry="send('Please continue.')"
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
          <!-- Over the log rather than in it, so it stays put and doesn't change what the scroll measures -->
          <div
            v-if="beside && latest"
            ref="card"
            tabindex="-1"
            data-testid="plan-beside"
            class="absolute top-4 right-4 flex max-h-[calc(100%-2rem)] w-85 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-sm focus-visible:outline-2 focus-visible:outline-primary"
          >
            <PlanDetail
              :plan="latest"
              :previous="previous"
              :busy="approving?.planId === latest.id"
              :disabled="cantApprove"
              card
              @approve="approve(latest, $event)"
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
          v-if="latest && !beside"
          #plan
        >
          <PlanDetail
            :plan="latest"
            :previous="previous"
            :busy="approving?.planId === latest.id"
            :disabled="cantApprove"
            @approve="approve(latest, $event)"
            @close="flyout.close()"
          />
        </template>
      </TaskFlyout>
    </div>
  </div>
</template>
