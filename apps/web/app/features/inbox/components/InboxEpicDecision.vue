<script setup lang="ts">
import type { EpicRebaseDecision } from '@corral/core'
import { useMutation } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
import { reviewEpic } from '~/queries/epics'

// A task fix's question (D29): what to choose between and what it touches.
// Picking one resumes the same fix; the composer answers in words.
const props = defineProps<{ item: { epicId: string, headSha: string, decision: EpicRebaseDecision } }>()
const deciding = useMutation(reviewEpic)
const pending = computed(() => deciding.isPending.value)
const chosen = ref<number | null>(null)
const error = computed(() => deciding.error.value?.message ?? null)
const toast = useToast()
async function choose(alternative: number) {
  chosen.value = alternative
  const { epicId, headSha } = props.item
  await deciding.mutateAsync({ id: epicId, input: { action: 'decide', alternative, headSha } })
  toast.add({ title: 'Done', description: 'Decision sent; the rebase carries on', color: 'success' })
}
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-md border border-border p-3"
    data-testid="inbox-epic-decision"
  >
    <div>
      <h2 class="text-sm font-semibold text-foreground">
        {{ item.decision.question }}
      </h2>
      <p
        v-if="item.decision.bindingDecision"
        class="mt-1 text-xs text-muted-foreground"
      >
        Binding decision: {{ item.decision.bindingDecision }}
      </p>
    </div>
    <p
      v-if="!item.decision.alternatives.length"
      class="text-sm text-muted-foreground"
    >
      The agent gave no alternatives. Choose Answer and write your decision: the rebase carries on from it, and review starts again.
    </p>
    <ul
      v-if="item.decision.alternatives.length"
      class="flex flex-col gap-2"
    >
      <li
        v-for="(alternative, index) in item.decision.alternatives"
        :key="alternative.label"
        class="flex items-start justify-between gap-3 text-sm"
      >
        <div class="min-w-0">
          <p class="font-medium">
            {{ alternative.label }}
          </p>
          <p class="text-muted-foreground">
            {{ alternative.effect }}
          </p>
          <p class="text-xs text-muted-foreground/70">
            {{ alternative.changesBehaviour ? 'Changes approved behaviour: review and your approval start again' : 'Keeps your approval' }}
          </p>
        </div>
        <AppButton
          label="Choose"
          size="xs"
          variant="outline"
          class="shrink-0"
          :aria-label="`Choose ${alternative.label}`"
          :loading="pending && chosen === index"
          :disabled="pending"
          @click="choose(index)"
        />
      </li>
    </ul>
    <div v-if="item.decision.affectedChanges.length">
      <h3 class="text-xs font-medium text-muted-foreground">
        Affected changes
      </h3>
      <ul class="mt-1 list-inside list-disc text-sm">
        <li
          v-for="change in item.decision.affectedChanges"
          :key="change"
        >
          {{ change }}
        </li>
      </ul>
    </div>
    <AppAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
    />
  </section>
</template>
