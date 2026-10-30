<script setup lang="ts">
import type { Plan, PlanSessionDetail, PlanThreadItem } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { FLYOUT_SHEETS } from '~/composables/useTaskFlyout'
import { approvePlan } from '~/utils/plan-approval'
import { timeAgo } from '~/utils/labels'
import { STOP_ASKING } from '~/utils/plan-questions'

// Inbox shows the decision only. The session is loaded for the plan sheet;
// its messages and run transcript belong in Plan, never on this screen.
const props = defineProps<{ item: PlanThreadItem, onRefresh: () => Promise<void> }>()
const router = useRouter()
const live = useLive()
const threads = usePlanThreads()
const deleting = usePlanThreadDelete()
const flyout = useTaskFlyout()
// A task or epic opened from the plan sheet opens in a taller sheet over it,
// on this route, rather than on its own page (design/inbox.md#mobile)
provide(FLYOUT_SHEETS, true)
const toast = useToast()
const text = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const session = ref<PlanSessionDetail | null>(null)
const loadingPlan = ref(false)
const composer = ref<{ focus: () => void } | null>(null)
const offline = computed(() => live.state.value.loaded && !live.state.value.runner?.online)
const working = computed(() => Boolean(props.item.activeRunId))
const cantSend = computed(() => busy.value || offline.value || working.value)
// A question or an unread reply is answered here; a plan is approved instead
const canReply = computed(() => Boolean(props.item.question || (!props.item.plan && props.item.reply)))
const latest = computed(() => session.value?.plans.find(p => p.id === props.item.planId) ?? null)
const previous = computed(() => session.value?.plans.find(p => p.version === (latest.value?.version ?? 0) - 1) ?? null)
// The plan sheet stays under a task or epic opened from it
const planUnder = ref(false)
const detailSheet = computed({
  get: () => Boolean(flyout.ref.value || flyout.epic.value),
  // Dismissing goes back to what the item was opened from: the plan, or another item
  set: (open) => {
    if (open || !detailSheet.value) return
    if (planUnder.value || flyout.canGoBack.value) flyout.back()
    else void flyout.close()
  }
})
watch([flyout.plan, detailSheet], ([, detail], [wasPlan]) => {
  planUnder.value = detail && (planUnder.value || wasPlan)
})
const planSheet = computed({
  get: () => flyout.plan.value || (planUnder.value && detailSheet.value),
  set: (open) => { if (!open && flyout.plan.value) void flyout.close() }
})
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e)

async function loadPlan() {
  loadingPlan.value = true
  error.value = null
  try {
    session.value = await api.plan.session(props.item.sessionId)
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    loadingPlan.value = false
  }
}
watch(() => props.item.planId, (id) => {
  if (id) void loadPlan()
}, { immediate: true })
onMounted(() => {
  // A read acknowledgement removes an unread-reply-only item from the Inbox.
  if (props.item.unread) {
    void api.plan.read(props.item.sessionId).then(props.onRefresh).catch((e) => {
      error.value = messageOf(e)
    })
  }
})
async function send(message: string): Promise<boolean> {
  if (cantSend.value) return false
  busy.value = true
  error.value = null
  try {
    await api.plan.message(props.item.sessionId, message)
    threads.add(props.item.sessionId)
    text.value = ''
    await props.onRefresh()
    await router.replace('/inbox')
    return true
  } catch (e) {
    error.value = messageOf(e)
    return false
  } finally {
    busy.value = false
  }
}
async function approve(plan: Plan, to: 'ready' | 'backlog') {
  if (busy.value) return
  busy.value = true
  try {
    await approvePlan(plan, to, {
      approve: api.plan.approve,
      toast,
      mobile: true,
      closeSheet: flyout.close,
      push: async () => {
        await props.onRefresh()
        await router.replace('/inbox')
      }
    })
  } finally {
    busy.value = false
  }
}
// Deleting waits five seconds for Undo before closing the session; the
// thread leaves the list at once (design/inbox.md#mobile)
async function deleteThread() {
  deleting.remove(props.item.sessionId, props.onRefresh)
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
          active
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
            Plan v{{ item.plan.version }} · {{ item.plan.epicCount }} {{ item.plan.epicCount === 1 ? 'epic' : 'epics' }} · {{ item.plan.taskCount }} {{ item.plan.taskCount === 1 ? 'task' : 'tasks' }}
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
              :disabled="!latest"
              @click="latest && approve(latest, 'ready')"
            />
            <UButton
              label="Approve to Backlog"
              variant="outline"
              class="min-h-11 min-w-0 flex-1 justify-center text-xs"
              :disabled="!latest || busy"
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
            <span class="font-medium text-default">{{ item.sender.name }}</span> · {{ timeAgo(item.at) }}
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
        @submit="send"
      />
    </div>
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
            :plan="latest"
            :previous="previous"
            :busy="busy"
            sheet
            class="flex-1"
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
            :task-ref="flyout.ref.value"
            mode="flyout"
            class="flex-1"
            @close="detailSheet = false"
          />
          <EpicDetail
            v-else-if="flyout.epic.value"
            :epic-id="flyout.epic.value"
            mode="flyout"
            class="flex-1"
            @close="detailSheet = false"
          />
        </div>
      </template>
    </UDrawer>
  </div>
</template>
