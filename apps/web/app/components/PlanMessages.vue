<script setup lang="ts">
import type { Plan, PlanMessage, PlanSessionDetail } from '@corral/contracts'
import { answerTo, openQuestionId } from '~/utils/plan-questions'

// The messages of a Plan conversation. Its own component with what each message
// needs worked out once, so typing in the composer re-renders none of this.
const props = defineProps<{
  session: Pick<PlanSessionDetail, 'messages' | 'plans'>
  pmName: string
  activeRunId: string | null
  latest: Plan | null
  cantSend: boolean
  // The plan start in flight, for its first message
  refining?: string | null
  failed?: boolean
}>()
const emit = defineEmits<{ retry: [], answer: [text: string], other: [], stop: [] }>()
const flyout = useTaskFlyout()
const device = useDevice()

const openQuestion = computed(() => openQuestionId(props.session.messages))
const rows = computed(() => {
  const { messages, plans } = props.session
  // What each turn posted, in order, and its first message
  const replies = new Map<string, string[]>()
  const firsts = new Map<string, string>()
  for (const m of messages) {
    if (m.role !== 'pm' || m.runId === null) continue
    replies.set(m.runId, [...replies.get(m.runId) ?? [], m.text])
    if (!firsts.has(m.runId)) firsts.set(m.runId, m.id)
  }
  return messages.map((message: PlanMessage) => ({
    message,
    plan: plans.find(p => p.id === message.planId) ?? null,
    // A finished turn's steps sit above its first message
    firstOfTurn: message.runId !== null && message.runId !== props.activeRunId && firsts.get(message.runId) === message.id,
    replies: message.runId === null ? [] : replies.get(message.runId) ?? [],
    answer: message.kind === 'question' ? answerTo(messages, message.id) : undefined
  }))
})
</script>

<template>
  <div
    v-for="{ message, plan, firstOfTurn, replies, answer } in rows"
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
        v-if="props.refining && message.id === props.session.messages[0]?.id"
        variant="subtle"
        class="mt-2"
      >
        Refining <TaskLink
          :task-ref="props.refining"
          class="underline"
        />
      </UBadge>
      <span
        v-if="props.failed && message.id.startsWith('pending-')"
        class="block text-xs text-error"
      >Not sent</span>
    </div>
    <!-- Full width on phones, so a question's answers span the screen -->
    <div
      v-else
      :class="['flex max-w-full min-w-0 gap-2', device.isMobile.value && 'flex-1']"
    >
      <AgentAvatar
        :name="props.pmName"
        size="sm"
      />
      <div :class="['flex min-w-0 flex-col gap-2', device.isMobile.value && 'flex-1']">
        <span class="text-xs text-muted">{{ props.pmName }} · PM</span>
        <PlanTurnSteps
          v-if="firstOfTurn"
          :run-id="message.runId!"
          :replies="replies"
          :agent-name="props.pmName"
        />
        <UAlert
          v-if="message.kind === 'error'"
          color="error"
          variant="subtle"
          :title="message.text"
          :actions="[{ label: 'Retry', onClick: () => emit('retry') }]"
        />
        <PlanQuestion
          v-else-if="message.kind === 'question'"
          :message="message"
          :active="message.id === openQuestion"
          :answer="answer"
          :disabled="props.cantSend"
          :stacked="device.isMobile.value"
          @answer="emit('answer', $event)"
          @other="emit('other')"
          @stop="emit('stop')"
        />
        <div
          v-else
          class="text-sm"
        >
          <MarkdownText :text="message.text" />
        </div>
        <button
          v-if="plan"
          type="button"
          :class="['flex max-w-full items-center gap-2 self-start rounded-md border border-default px-3 py-2 text-start text-sm hover:bg-elevated', flyout.plan.value && 'bg-elevated']"
          @click="flyout.plan.value ? flyout.close() : flyout.openPlan()"
        >
          <UIcon
            name="i-lucide-list-checks"
            class="size-4 shrink-0 text-muted"
          />
          <span class="min-w-0 truncate">
            <span class="font-medium">Plan v{{ plan.version }}</span> · {{ plan.title }}
          </span>
          <span class="shrink-0 text-xs text-muted">{{ plan.id === props.latest?.id ? 'Open plan' : `Now v${props.latest?.version}` }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
