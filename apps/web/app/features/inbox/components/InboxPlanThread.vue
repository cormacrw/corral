<script setup lang="ts">
import { planThreadPath } from '~/utils/routes'
import type { PlanThreadItem } from '@corral/contracts'
import type { PlanApprovalTarget } from '@corral/core'
import { useInboxPlanThread } from '~/features/inbox/composables/useInboxPlanThread'
import { inboxKind } from '~/utils/inbox-kinds'
import { runtimeLabel } from '~/utils/labels'
import { STOP_ASKING } from '~/features/plan/utils/plan-questions'
import InboxPanelLayout from '~/features/inbox/components/InboxPanelLayout.vue'
import PlanDetailBody from '~/features/plan/components/PlanDetailBody.vue'
import { provideFlyoutHost } from '~/composables/useTaskFlyout'

// A Plan thread in the Inbox (design/inbox.md#detail-pane): only what needs
// you, the question or the plan, never the conversation. The full
// conversation is one click away with Open in Plan. It shares the task
// panel's frame, so a plan to approve reads like a task to review: what it is
// up top, the plan in the body, the actions and the reply box at the bottom.
const props = defineProps<{ item: PlanThreadItem }>()
provideFlyoutHost({ docked: () => true })
const { detail, plan, previous, counts, text, busy, offline: runnerOffline, working, cantSend, cantApprove, approving, send, quick, approve, writing, answer, submitAnswer, remove, log, content, onLogScroll, composer } = useInboxPlanThread(() => props.item)
const layout = ref<{ scroller: HTMLElement | null } | null>(null)
watchEffect(() => {
  log.value = layout.value?.scroller ?? null
})
const kind = computed(() => inboxKind(props.item))
const tabs = [{ label: 'Overview', value: 'overview' }]
// A plan's composer is for its Request changes action, so it stays hidden
// until that's chosen. A question or a failed turn needs the reply box.
const requesting = ref(false)
watch(() => props.item.id, () => {
  requesting.value = false
})
const showComposer = computed(() => !props.item.question && (!props.item.plan || requesting.value))
function requestChanges() {
  requesting.value = !requesting.value
  if (requesting.value) void nextTick(() => composer.value?.focus())
}
async function sendChanges(message: string): Promise<boolean> {
  const sent = await send(message)
  if (sent && props.item.plan) requesting.value = false
  return sent
}
function approveTo(to: PlanApprovalTarget) {
  if (props.item.plan) void approve(props.item.plan, to)
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-1 max-[1100px]:flex-col">
    <InboxPanelLayout
      ref="layout"
      data-testid="inbox-plan-thread"
      :item="item"
      :kind="kind"
      :tabs="tabs"
      open-tab="overview"
      @scroll="onLogScroll"
    >
      <template #header>
        <p class="text-xs text-muted-foreground">
          Runs on {{ runtimeLabel(item.runtime) }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <AppButton
            :to="planThreadPath(item.sessionId)"
            label="Open in Plan"
            icon="i-hugeicons-bubble-chat"
            variant="outline"
            color="neutral"
            size="sm"
          />
        </div>
      </template>

      <div
        ref="content"
        class="flex w-full flex-col gap-4"
      >
        <template v-if="item.question">
          <PlanQuestion
            :message="item.question"
            data-message-id="inbox-question"
            :active="!working"
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
        </template>

        <!-- The whole plan, in place of a card that opens it -->
        <section
          v-else-if="item.plan"
          class="-mx-5 -mt-5"
          data-testid="inbox-plan"
        >
          <PlanDetailBody
            v-if="plan"
            :plan="plan"
            :previous="previous"
            class="[&>*]:px-5"
          >
            <template
              v-if="plan.title === item.subject"
              #title
            />
            <MarkdownText
              :text="plan.summary"
              class="mt-1 text-sm"
            />
          </PlanDetailBody>
          <div
            v-else
            class="flex flex-col gap-3 px-5 pt-4"
          >
            <h2 class="text-lg font-semibold">
              {{ item.plan.title }}
            </h2>
            <span class="text-xs text-muted-foreground">{{ counts }}</span>
            <MarkdownText
              :text="item.plan.summary"
              class="text-sm"
            />
            <UiSkeleton
              v-if="detail.isPending.value"
              class="h-32 w-full"
              data-testid="inbox-plan-loading"
            />
            <AppLoadError
              v-else
              :title="detail.error.value?.message ?? 'Couldn\'t load this plan'"
              :retry="() => detail.refetch()"
              data-testid="inbox-plan-error"
            />
          </div>
        </section>

        <section
          v-else-if="item.failure"
          class="flex flex-col gap-3"
          data-testid="inbox-plan-failure"
        >
          <p class="text-sm text-foreground">
            {{ item.sender.name }}'s turn failed and nothing will retry it. Send a message to try again, or delete the thread.
          </p>
          <MarkdownText
            :text="item.failure"
            class="text-sm"
          />
        </section>

        <div
          v-if="working"
          class="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="inbox-plan-working"
        >
          <Icon
            name="i-hugeicons-loading-03"
            class="size-4 animate-spin"
          />
          {{ item.sender.name }} is working on it.
        </div>
      </div>

      <template #footer>
        <div class="flex shrink-0 flex-col gap-2 border-t border-border p-3">
          <PlanRunnerOffline />
          <div
            class="flex flex-wrap items-center gap-2"
            data-testid="inbox-actions"
          >
            <template v-if="item.plan">
              <AppButton
                label="Approve to board"
                icon="i-hugeicons-tick-02"
                size="sm"
                :loading="approving?.to === 'ready'"
                :disabled="cantApprove"
                data-testid="inbox-primary"
                @click="approveTo('ready')"
              />
              <AppButton
                label="Approve to Backlog"
                icon="i-hugeicons-archive-02"
                color="neutral"
                variant="outline"
                size="sm"
                :loading="approving?.to === 'backlog'"
                :disabled="cantApprove"
                @click="approveTo('backlog')"
              />
              <AppButton
                label="Request changes"
                icon="i-hugeicons-pencil-edit-02"
                color="neutral"
                :variant="requesting ? 'subtle' : 'outline'"
                size="sm"
                :aria-pressed="requesting"
                :disabled="approving !== null"
                @click="requestChanges"
              />
            </template>
            <AppButton
              v-if="item.question && writing"
              label="Submit"
              icon="i-hugeicons-arrow-up-02"
              size="sm"
              :loading="busy"
              :disabled="!answer.trim() || cantSend"
              data-testid="inbox-primary"
              @click="submitAnswer"
            />
            <!-- Deletes at once, with Undo in a toast (design/inbox.md#delete-thread) -->
            <AppButton
              label="Delete thread"
              icon="i-hugeicons-delete-02"
              color="error"
              variant="outline"
              size="sm"
              :disabled="approving !== null"
              @click="remove"
            />
          </div>
          <PromptComposer
            v-if="showComposer"
            ref="composer"
            v-model="text"
            :placeholder="item.plan ? `What should ${item.sender.name} change?` : `Reply to ${item.sender.name}…`"
            :disabled="runnerOffline || working"
            :busy="busy"
            :rows="1"
            :project="item.project?.slug"
            :draft-key="`inbox:${item.id}`"
            @submit="sendChanges"
          />
        </div>
      </template>
    </InboxPanelLayout>

    <!-- A task opened from the plan -->
    <TaskFlyout />
  </div>
</template>
