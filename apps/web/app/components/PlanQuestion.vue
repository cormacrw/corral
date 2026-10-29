<script setup lang="ts">
import type { PlanMessage } from '@corral/contracts'
import { computed } from 'vue'
import { STOP_ASKING } from '~/utils/plan-questions'

// A PM question in the Plan log (design/plan.md). With a recommendation or
// options it has one-tap answers, live only on the open question; once
// answered, the chosen one stays marked. Stacked (on phones), the open
// question's answers are full-width tap targets, at least 44px tall.
const props = defineProps<{
  message: Pick<PlanMessage, 'text' | 'recommendation' | 'options'>
  // The latest question, not answered yet
  active?: boolean
  // What you answered with, if you have
  answer?: string | null
  // Can't send right now (a turn is running, or the runner is offline)
  disabled?: boolean
  // One answer per row, for thumbs (design/mobile.md)
  stacked?: boolean
}>()
const emit = defineEmits<{ answer: [text: string], other: [], stop: [] }>()

const options = computed(() => props.message.options ?? [])
const interactive = computed(() => Boolean(props.message.recommendation) || options.value.length > 0)
const locked = computed(() => !props.active || props.disabled)
const answer = computed(() => props.answer ?? null)
const chose = (text: string) => answer.value === text
const choseOther = computed(() => answer.value !== null && answer.value !== props.message.recommendation
  && !options.value.includes(answer.value) && answer.value !== STOP_ASKING)
// Only the open question stacks; past ones keep the compact row, disabled
const stack = computed(() => props.stacked && props.active)
const size = computed(() => stack.value ? 'lg' : 'xs')
const tap = computed(() => stack.value ? 'min-h-11 w-full justify-center whitespace-normal text-center' : undefined)
</script>

<template>
  <div
    class="rounded-md border border-info/40 bg-info/5 px-3 py-2 text-sm"
    data-testid="plan-question"
  >
    <span class="mb-1 block text-xs font-medium text-info">Question</span>
    <MarkdownText :text="props.message.text" />
    <div
      v-if="interactive"
      class="mt-3 flex flex-col gap-2"
    >
      <div
        v-if="props.message.recommendation"
        :class="stack ? 'flex flex-col gap-2' : 'flex flex-wrap items-center gap-2'"
      >
        <span class="text-xs text-muted">Recommended: <span class="text-default">{{ props.message.recommendation }}</span></span>
        <UButton
          label="Accept recommendation"
          :size="size"
          :icon="chose(props.message.recommendation) ? 'i-lucide-check' : 'i-lucide-thumbs-up'"
          :variant="chose(props.message.recommendation) ? 'solid' : 'soft'"
          color="primary"
          :class="tap"
          :disabled="locked"
          :aria-pressed="chose(props.message.recommendation)"
          @click="emit('answer', props.message.recommendation)"
        />
      </div>
      <div :class="stack ? 'flex flex-col gap-2' : 'flex flex-wrap gap-2'">
        <UButton
          v-for="option in options"
          :key="option"
          :label="option"
          :size="size"
          :icon="chose(option) ? 'i-lucide-check' : undefined"
          :variant="chose(option) ? 'solid' : 'outline'"
          :color="chose(option) ? 'primary' : 'neutral'"
          :class="tap"
          :disabled="locked"
          :aria-pressed="chose(option)"
          @click="emit('answer', option)"
        />
        <UButton
          label="Other…"
          :size="size"
          :icon="choseOther ? 'i-lucide-check' : undefined"
          :variant="choseOther ? 'solid' : stack ? 'outline' : 'ghost'"
          :color="choseOther ? 'primary' : 'neutral'"
          :class="tap"
          :disabled="locked"
          :aria-pressed="choseOther"
          @click="emit('other')"
        />
        <UButton
          label="Stop and propose the plan"
          :size="size"
          :icon="chose(STOP_ASKING) ? 'i-lucide-check' : 'i-lucide-list-checks'"
          :variant="chose(STOP_ASKING) ? 'solid' : stack ? 'outline' : 'ghost'"
          :color="chose(STOP_ASKING) ? 'primary' : 'neutral'"
          :class="stack ? tap : 'ms-auto'"
          :disabled="locked"
          :aria-pressed="chose(STOP_ASKING)"
          @click="emit('stop')"
        />
      </div>
    </div>
  </div>
</template>
