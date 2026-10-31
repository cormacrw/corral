<script setup lang="ts">
import type { Plan, PlanThreadItem } from '@corral/contracts'
import { usePlanThread } from '~/composables/usePlanThread'
import { approvePlan } from '~/utils/plan-approval'
import { STOP_ASKING } from '~/utils/plan-questions'
import TimeAgo from '~/components/TimeAgo.vue'

// Inbox shows the decision only. The session is loaded for the plan sheet;
// its messages and run transcript belong in Plan, never on this screen.
const props = defineProps<{ item: PlanThreadItem }>()
const router = useRouter()
const deleting = usePlanThreadDelete()
const flyout = useTaskFlyout()
const toast = useToast()
const { approval, detail, plan: latest, previous, counts, text, busy, offline, working, cantSend, send: sendMessage } = usePlanThread(() => props.item)
const actionError = ref<string | null>(null)
const error = computed(() => actionError.value ?? detail.error.value?.message ?? null)
const loadingPlan = detail.isPending
const composer = ref<{ focus: () => void } | null>(null)
// A question or an unread reply is answered here; a plan is approved instead
const canReply = computed(() => Boolean(props.item.question || (!props.item.plan && props.item.reply)))
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e)

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
        <UButton
          :to="`/plan/${item.sessionId}`"
          label="Open in Plan"
          variant="ghost"
          color="neutral"
          class="min-h-11"
        />
        <UDropdownMenu :items="[{ label: 'Delete thread', icon: 'i-lucide-trash-2', color: 'error' as const, disabled: busy, onSelect: deleteThread }]">
          <UButton
            icon="i-lucide-ellipsis"
            variant="ghost"
            color="neutral"
            aria-label="Thread actions"
            class="min-h-11 min-w-11"
          />
        </UDropdownMenu>
      </template>
    </MobilePageHeader>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
      <div class="flex flex-col gap-4">
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
        />
        <PlanQuestion
          v-if="item.question"
          :message="item.question"
          :active="!working"
          stacked
          :disabled="cantSend"
          @answer="send"
          @other="composer?.focus()"
          @stop="send(STOP_ASKING)"
        />
        <template v-else-if="item.plan">
          <h2 class="text-lg font-semibold text-highlighted">
            {{ item.plan.title }}
          </h2>
          <MarkdownText :text="item.plan.summary" />
          <p class="text-sm text-muted">
            {{ counts }}
          </p>
          <UButton
            label="View plan"
            variant="outline"
            color="neutral"
            class="min-h-11 justify-center"
            :loading="loadingPlan"
            :disabled="!latest"
            @click="flyout.openPlan()"
          />
          <UButton
            v-if="!latest && !loadingPlan"
            label="Retry loading plan"
            variant="ghost"
            class="min-h-11"
            @click="loadPlan"
          />
          <div class="flex min-w-0 gap-2">
            <UButton
              label="Approve to board"
              class="min-h-11 min-w-0 flex-1 justify-center text-xs"
              :loading="busy"
              :disabled="!latest || working"
              @click="latest && approve(latest, 'ready')"
            />
            <UButton
              label="Approve to Backlog"
              variant="outline"
              class="min-h-11 min-w-0 flex-1 justify-center text-xs"
              :disabled="!latest || busy || working"
              @click="latest && approve(latest, 'backlog')"
            />
          </div>
        </template>
        <!-- An unread reply: Juno's latest message, answered from the composer -->
        <template v-else-if="item.reply">
          <span class="flex items-center gap-2 text-xs text-muted">
            <AgentAvatar
              :name="item.sender.name"
              size="xs"
            />
            <span class="font-medium text-default">{{ item.sender.name }}</span> · <TimeAgo :at="item.at" />
          </span>
          <MarkdownText :text="item.reply" />
        </template>
        <p
          v-if="working"
          role="status"
          class="text-sm text-muted"
        >
          {{ item.sender.name }} is working…
        </p>
      </div>
    </div>
    <div
      v-if="canReply"
      class="shrink-0 border-t border-default p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <UAlert
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
        :project="item.project.slug"
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
