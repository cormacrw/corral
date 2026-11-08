<script setup lang="ts">
import { planThreadPath } from '~/utils/routes'
import type { PlanThreadItem } from '@corral/contracts'
import { provideFlyoutHost } from '~/composables/useTaskFlyout'
import { useInboxPlanThread } from '~/features/inbox/composables/useInboxPlanThread'
import { STOP_ASKING } from '~/features/plan/utils/plan-questions'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// Inbox shows the decision only. The session is loaded for the plan sheet;
// its messages and run transcript belong in Plan, never on this screen.
const props = defineProps<{ item: PlanThreadItem }>()
// Task links in the summary and reply open in PlanSheets, not on the task's page
provideFlyoutHost({ sheets: true })
const flyout = useTaskFlyout()
const { detail, plan: latest, previous, counts, text, busy, working, cantSend, cantApprove, approving, send, quick, approve, writing, answer, submitAnswer, remove, log, content, onLogScroll, composer } = useInboxPlanThread(() => props.item)
const error = computed(() => detail.error.value?.message ?? null)
const loadingPlan = detail.isPending
// A failed turn is answered here, a question in its card (Other… is written
// there and sent with Submit), and a plan is approved instead
const canReply = computed(() => Boolean(props.item.failure))
</script>

<template>
  <div
    class="flex h-full min-h-0 flex-col"
    data-testid="inbox-plan-thread"
  >
    <MobilePageHeader compact>
      <template #actions>
        <AppButton
          :to="planThreadPath(item.sessionId)"
          label="Open in Plan"
          variant="ghost"
          color="neutral"
          class="min-h-11"
        />
        <AppDropdownMenu :items="[{ label: 'Delete thread', icon: 'i-hugeicons-delete-02', color: 'error' as const, disabled: approving !== null, onSelect: remove }]">
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
          :message="item.question"
          data-message-id="inbox-question"
          :active="!working"
          stacked
          :disabled="cantSend"
          :writing="writing"
          @answer="quick"
          @other="writing = !writing"
          @stop="quick(STOP_ASKING)"
        >
          <template #other>
            <InboxQuestionAnswer
              v-model="answer"
              :disabled="cantSend"
              @submit="submitAnswer"
            />
          </template>
        </PlanQuestion>
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
            @click="detail.refetch()"
          />
          <div class="flex min-w-0 gap-2">
            <AppButton
              label="Approve to board"
              class="min-h-11 min-w-0 flex-1 justify-center text-xs"
              :loading="approving?.to === 'ready'"
              :disabled="!latest || cantApprove"
              @click="latest && approve(latest, 'ready')"
            />
            <AppButton
              label="Approve to Backlog"
              variant="outline"
              class="min-h-11 min-w-0 flex-1 justify-center text-xs"
              :loading="approving?.to === 'backlog'"
              :disabled="!latest || cantApprove"
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
      <PlanRunnerOffline class="mb-2" />
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
      :busy="approving !== null"
      :disabled="cantApprove"
      @approve="latest && approve(latest, $event)"
    />
  </div>
</template>
