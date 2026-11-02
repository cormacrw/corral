<script setup lang="ts">
import type { EpicRebaseDecision } from '@corral/core'
import { useMutation } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
import { reviewEpic } from '~/queries/epics'
import { actOnInboxItem } from '~/queries/inbox'

// An epic rebase's question (COR-291): what to choose between and what it
// touches. Picking one resumes the same rebase; the composer answers in words.
// An epic fix has no task, so its answer goes to the epic (D29).
const props = defineProps<{ item: { taskId: string | null, epicId?: string | undefined, headSha?: string | undefined, decision: EpicRebaseDecision } }>()
const deciding = useMutation(actOnInboxItem)
const decidingEpic = useMutation(reviewEpic)
const pending = computed(() => deciding.isPending.value || decidingEpic.isPending.value)
const chosen = ref<number | null>(null)
const error = computed(() => deciding.error.value?.message ?? decidingEpic.error.value?.message ?? null)
const toast = useToast()
async function choose(alternative: number) {
  chosen.value = alternative
  const { taskId, epicId, headSha } = props.item
  if (taskId) await deciding.mutateAsync({ taskId, input: { action: 'decide', alternative } })
  else await decidingEpic.mutateAsync({ id: epicId!, input: { action: 'decide', alternative, headSha: headSha! } })
  toast.add({ title: 'Done', description: 'Decision sent; the rebase carries on', color: 'success' })
}
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-md border border-default p-3"
    data-testid="inbox-epic-decision"
  >
    <div>
      <h2 class="text-sm font-semibold text-highlighted">
        {{ item.decision.question }}
      </h2>
      <p
        v-if="item.decision.bindingDecision"
        class="mt-1 text-xs text-muted"
      >
        Binding decision: {{ item.decision.bindingDecision }}
      </p>
    </div>
    <ul class="flex flex-col gap-2">
      <li
        v-for="(alternative, index) in item.decision.alternatives"
        :key="alternative.label"
        class="flex items-start justify-between gap-3 text-sm"
      >
        <div class="min-w-0">
          <p class="font-medium">
            {{ alternative.label }}
          </p>
          <p class="text-muted">
            {{ alternative.effect }}
          </p>
          <p class="text-xs text-dimmed">
            {{ alternative.changesBehaviour ? 'Changes approved behaviour: review and your approval start again' : 'Keeps your approval' }}
          </p>
        </div>
        <UButton
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
    <div>
      <h3 class="text-xs font-medium text-muted">
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
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
    />
  </section>
</template>
