<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
import type { PlanThreadItem } from '@corral/contracts'
import { approvedPlanSummary } from '@corral/core'
import { useInboxPlanThread } from '~/features/inbox/composables/useInboxPlanThread'
import { runtimeLabel } from '~/utils/labels'
import { STOP_ASKING } from '~/features/plan/utils/plan-questions'

// A Plan thread in the Inbox (design/inbox.md#detail-pane): only what needs
// you, the question or the plan, never the conversation. The full
// conversation is one click away with Open in Plan.
const props = defineProps<{ item: PlanThreadItem }>()
const emit = defineEmits<{ approved: [], delete: [] }>()
const flyout = useTaskFlyout()
const toast = useToast()
const { approval, detail, plan, previous, counts, text, busy, offline: runnerOffline, working, cantSend, send: sendMessage, log, content, onLogScroll, composer } = useInboxPlanThread(() => props.item)
async function send(message: string): Promise<boolean> {
  if (cantSend.value) return false
  try {
    await sendMessage(message)
    return true
  } catch (e) {
    toast.add({ title: 'Could not send', description: errorMessage(e), color: 'error' })
    return false
  }
}

const approving = ref<'ready' | 'backlog' | null>(null)
async function approve(to: 'ready' | 'backlog') {
  if (!props.item.plan || approving.value || working.value) return
  approving.value = to
  try {
    const approved = await approval.mutateAsync({ planId: props.item.plan.id, to })
    toast.add({ title: 'Resolved', description: approvedPlanSummary(approved.tasks), color: 'success' })
    await flyout.close()
    emit('approved')
  } catch (e) {
    toast.add({ title: 'Could not approve', description: errorMessage(e), color: 'error' })
  } finally {
    approving.value = null
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-1 max-[1100px]:flex-col">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <AgentAvatar
          :name="item.sender.name"
          size="sm"
        />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-sm font-medium">
            {{ item.subject }}
          </h1>
          <div class="flex min-w-0 items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
            <span class="shrink-0"><span class="font-medium text-foreground">{{ item.sender.name }}</span> · PM</span>
            <span class="flex min-w-0 items-center gap-1"><ProjectThumbnail
              v-if="item.project"
              :project="item.project"
              :size="16"
            /><span class="truncate">{{ item.project?.name ?? 'Global' }}</span></span>
            <AppBadge
              :label="item.status === 'needs_approval' ? 'Needs approval' : item.status === 'question' ? 'Question' : 'Failed'"
              :color="item.status === 'needs_approval' ? 'primary' : item.status === 'question' ? 'info' : 'error'"
              variant="subtle"
              size="xs"
              class="shrink-0"
            />
            <AppBadge
              :label="runtimeLabel(item.runtime)"
              variant="subtle"
              color="neutral"
              size="xs"
              class="shrink-0"
            />
          </div>
        </div>
        <AppButton
          :to="`/plan/${item.sessionId}`"
          label="Open in Plan"
          variant="ghost"
          color="neutral"
          size="sm"
        />
        <!-- Deletes at once, with Undo in a toast (design/inbox.md#delete-thread) -->
        <AppButton
          label="Delete thread"
          icon="i-hugeicons-delete-02"
          variant="ghost"
          color="error"
          size="sm"
          @click="emit('delete')"
        />
      </header>

      <div
        ref="log"
        class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
        @scroll.passive="onLogScroll"
      >
        <div
          ref="content"
          class="mx-auto flex w-full max-w-[720px] flex-col gap-4"
        >
          <template v-if="item.question">
            <PlanQuestion
              :message="item.question"
              data-message-id="inbox-question"
              :active="!working"
              :disabled="cantSend"
              @answer="send"
              @other="composer?.focus()"
              @stop="send(STOP_ASKING)"
            />
          </template>

          <section
            v-else-if="item.plan"
            class="flex flex-col gap-3 rounded-md border border-border p-4"
            data-testid="inbox-plan"
          >
            <span class="text-xs font-medium text-muted-foreground">{{ counts }}</span>
            <h2 class="text-base font-semibold">
              {{ item.plan.title }}
            </h2>
            <MarkdownText
              :text="item.plan.summary"
              class="text-sm"
            />
            <AppLoadError
              v-if="!plan && !detail.isPending.value"
              :title="detail.error.value?.message ?? 'Couldn\'t load this plan'"
              :retry="() => detail.refetch()"
              data-testid="inbox-plan-error"
            />
            <div class="flex flex-wrap gap-2">
              <AppButton
                label="View plan"
                icon="i-hugeicons-task-done-01"
                variant="outline"
                color="neutral"
                size="sm"
                :aria-pressed="flyout.plan.value"
                :loading="detail.isPending.value"
                :disabled="!plan"
                @click="flyout.plan.value ? flyout.close() : flyout.openPlan()"
              />
              <AppButton
                label="Approve to board"
                size="sm"
                :loading="approving === 'ready'"
                :disabled="approving !== null || working"
                @click="approve('ready')"
              />
              <AppButton
                label="Approve to Backlog"
                variant="outline"
                size="sm"
                :loading="approving === 'backlog'"
                :disabled="approving !== null || working"
                @click="approve('backlog')"
              />
              <AppButton
                :to="`/plan/${item.sessionId}`"
                label="Open in Plan"
                variant="ghost"
                color="neutral"
                size="sm"
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
            <AppButton
              :to="`/plan/${item.sessionId}`"
              label="Open in Plan"
              icon="i-hugeicons-bubble-chat"
              variant="outline"
              color="neutral"
              size="sm"
              class="self-start"
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
      </div>

      <div
        v-if="!item.plan"
        class="shrink-0 border-t border-border p-3"
      >
        <div class="mx-auto w-full max-w-[720px]">
          <AppAlert
            v-if="runnerOffline"
            color="warning"
            variant="subtle"
            icon="i-hugeicons-server-stack-01"
            title="Plan needs the runner. It's offline."
            class="mb-2"
          />
          <PromptComposer
            ref="composer"
            v-model="text"
            :placeholder="`Reply to ${item.sender.name}…`"
            :disabled="runnerOffline || working"
            :busy="busy"
            :project="item.project?.slug"
            :draft-key="`inbox:${item.id}`"
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
          :disabled="working"
          @approve="approve"
          @close="flyout.close()"
        />
      </template>
    </TaskFlyout>
  </div>
</template>
