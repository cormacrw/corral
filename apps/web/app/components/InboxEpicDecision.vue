<script setup lang="ts">
import type { TaskInboxItem } from '@corral/contracts'
import { useMutation } from '@tanstack/vue-query'
import { actOnInboxItem } from '~/queries/inbox'

// An epic rebase's question (COR-291): what to choose between and what it
// touches. Picking one resumes the same rebase; the composer answers in words.
const props = defineProps<{ item: TaskInboxItem & { decision: NonNullable<TaskInboxItem['decision']> } }>()
const deciding = useMutation(actOnInboxItem)
const toast = useToast()
async function choose(alternative: number) {
  await deciding.mutateAsync({ taskId: props.item.taskId, input: { action: 'decide', alternative } })
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
          :loading="deciding.isPending.value && deciding.variables.value?.input.action === 'decide' && deciding.variables.value.input.alternative === index"
          :disabled="deciding.isPending.value"
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
      v-if="deciding.error.value"
      color="error"
      variant="subtle"
      :title="deciding.error.value.message"
    />
  </section>
</template>
