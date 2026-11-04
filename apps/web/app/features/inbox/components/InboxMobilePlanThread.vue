<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
import { provide } from 'vue'
import type { Plan, PlanThreadItem } from '@corral/contracts'
import { FLYOUT_SHEETS } from '~/features/tasks/composables/useTaskFlyout'
import { useInboxPlanThread } from '~/features/inbox/composables/useInboxPlanThread'
import { approvePlan } from '~/features/plan/utils/plan-approval'
import { STOP_ASKING } from '~/features/plan/utils/plan-questions'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// Inbox shows the decision only. The session is loaded for the plan sheet;
// its messages and run transcript belong in Plan, never on this screen.
const props = defineProps<{ item: PlanThreadItem }>()
const router = useRouter()
const deleting = usePlanThreadDelete()
// Task links in the summary and reply open in PlanSheets, not on the task's page
provide(FLYOUT_SHEETS, true)
const flyout = useTaskFlyout()
const toast = useToast()
const { approval, detail, plan: latest, previous, counts, text, busy, offline, working, cantSend, send: sendMessage, log, content, onLogScroll, composer } = useInboxPlanThread(() => props.item)
const actionError = ref<string | null>(null)
const error = computed(() => actionError.value ?? detail.error.value?.message ?? null)
const loadingPlan = detail.isPending
// A failed turn is answered here, a question in its card (Other… is written
// there and sent with Submit), and a plan is approved instead
const canReply = computed(() => Boolean(props.item.failure))
const writing = ref(false)
const answer = ref('')
watch(() => props.item.id, () => {
  writing.value = false
  answer.value = ''
})
async function submitAnswer() {
  const message = answer.value.trim()
  if (!message || !await send(message)) return
  answer.value = ''
  writing.value = false
}
const messageOf = (e: unknown) => errorMessage(e)

const loadPlan = () => {
  actionError.value = null
  return detail.refetch()
}
async function send(message: string): Promise<boolean> {
  if (cantSend.value) return false
  actionError.value = null
  try {
    await sendMessage(message)
    await router.replace('/inbox')
    return true
  } catch (e) {
    actionError.value = messageOf(e)
    return false
  }
}
async function approve(plan: Plan, to: 'ready' | 'backlog') {
  if (busy.value || working.value) return
  busy.value = true
  try {
    await approvePlan(plan, to, {
      approve: (planId, to) => approval.mutateAsync({ planId, to }),
      toast,
      mobile: true,
      closeSheet: flyout.close,
      push: () => router.replace('/inbox')
    })
  } finally {
    busy.value = false
  }
}
// Deleting waits five seconds for Undo before closing the session; the
// thread leaves the list at once (design/inbox.md#mobile)
async function deleteThread() {
  deleting.remove(props.item.sessionId)
  await flyout.close()
  await router.replace('/inbox')
}
</script>

<template>
  <div
    class="flex h-full min-h-0 flex-col"
    data-testid="inbox-plan-thread"
  >
    <MobilePageHeader compact>
      <template #actions>
        <AppButton
          :to="`/plan/${item.sessionId}`"
          label="Open in Plan"
          variant="ghost"
          color="neutral"
          class="min-h-11"
        />
        <AppDropdownMenu :items="[{ label: 'Delete thread', icon: 'i-hugeicons-delete-02', color: 'error' as const, disabled: busy, onSelect: deleteThread }]">
          <AppButton
            icon="i-hugeicons-more-horizontal"
            variant="ghost"
            color="neutral"
            aria-label="Thread actions"
            class="min-h-11 min-w-11"
          />
        </AppDropdownMenu>
      </template>
    </MobilePageHeader>
    <div
      ref="log"
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
      @scroll.passive="onLogScroll"
    >
      <div
        ref="content"
        class="flex flex-col gap-4"
      >
        <AppAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
        />
        <PlanQuestion
          v-if="item.question"
          v-model:draft="answer"
          :message="item.question"
          data-message-id="inbox-question"
          :active="!working"
          stacked
          :disabled="cantSend"
          :writing="writing"
          @answer="send"
          @other="writing = !writing"
          @stop="send(STOP_ASKING)"
          @submit="submitAnswer"
        />
        <template v-else-if="item.plan">
          <h2 class="text-lg font-semibold text-foreground">
            {{ item.plan.title }}
          </h2>
          <MarkdownText :text="item.plan.summary" />
          <p class="text-sm text-muted-foreground">
            {{ counts }}
          </p>
          <AppButton
            label="View plan"
            variant="outline"
            color="neutral"
            class="min-h-11 justify-center"
            :loading="loadingPlan"
            :disabled="!latest"
            @click="flyout.openPlan()"
          />
          <AppButton
            v-if="!latest && !loadingPlan"
            label="Retry loading plan"
            variant="ghost"
            class="min-h-11"
            @click="loadPlan"
          />
          <div class="flex min-w-0 gap-2">
            <AppButton
              label="Approve to board"
              class="min-h-11 min-w-0 flex-1 justify-center text-xs"
              :loading="busy"
              :disabled="!latest || working"
              @click="latest && approve(latest, 'ready')"
            />
            <AppButton
              label="Approve to Backlog"
              variant="outline"
              class="min-h-11 min-w-0 flex-1 justify-center text-xs"
              :disabled="!latest || busy || working"
              @click="latest && approve(latest, 'backlog')"
            />
          </div>
        </template>
        <!-- A failed turn: why it failed, retried with a message from the composer -->
        <template v-else-if="item.failure">
          <span class="flex items-center gap-2 text-xs text-muted-foreground">
            <AgentAvatar
              :name="item.sender.name"
              size="xs"
            />
            <span class="font-medium text-foreground">{{ item.sender.name }}</span> · <TimeAgo :at="item.at" />
          </span>
          <p class="text-sm text-foreground">
            {{ item.sender.name }}'s turn failed and nothing will retry it. Send a message to try again, or delete the thread.
          </p>
          <MarkdownText :text="item.failure" />
        </template>
        <p
          v-if="working"
          role="status"
          class="text-sm text-muted-foreground"
        >
          {{ item.sender.name }} is working…
        </p>
      </div>
    </div>
    <div
      v-if="item.question && writing"
      class="shrink-0 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <AppButton
        label="Submit"
        icon="i-hugeicons-arrow-up-02"
        class="min-h-11 w-full justify-center"
        :loading="busy"
        :disabled="!answer.trim() || cantSend"
        data-testid="inbox-primary"
        @click="submitAnswer"
      />
    </div>
    <div
      v-if="canReply"
      class="shrink-0 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <AppAlert
        v-if="offline"
        color="warning"
        variant="subtle"
        title="Plan needs the runner. It's offline."
        class="mb-2"
      />
      <PromptComposer
        ref="composer"
        v-model="text"
        :placeholder="`Reply to ${item.sender.name}…`"
        :project="item.project?.slug"
        :disabled="cantSend"
        :busy="busy"
        :draft-key="`inbox:${item.id}`"
        @submit="send"
      />
    </div>
    <PlanSheets
      :plan="latest"
      :previous="previous"
      :busy="busy"
      :disabled="working"
      @approve="latest && approve(latest, $event)"
    />
  </div>
</template>
