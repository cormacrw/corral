<script setup lang="ts">
import type { Plan } from '@corral/contracts'
import { FLYOUT_SHEETS } from '~/composables/useTaskFlyout'

// Phones show the plan in a bottom sheet, and a task or epic from it in a
// taller sheet over it (design/plan.md#mobile), wherever a plan is on screen.
// Opening from inside stays on this route rather than going to the task's page.
const props = defineProps<{ plan: Plan | null, previous: Plan | null, busy: boolean, disabled?: boolean }>()
const emit = defineEmits<{ approve: [to: 'ready' | 'backlog'] }>()
provide(FLYOUT_SHEETS, true)
const flyout = useTaskFlyout()

// The plan sheet stays under a task or epic opened from it
const planUnder = ref(false)
// The drawers also report closing when the route closed them, so check first
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
</script>

<template>
  <UDrawer
    v-model:open="planSheet"
    :title="props.plan ? `Plan v${props.plan.version}` : 'Plan'"
    :ui="{ content: 'h-[88svh]' }"
  >
    <template #content>
      <div
        v-if="props.plan"
        class="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]"
        data-testid="plan-sheet"
      >
        <PlanDetail
          :plan="props.plan"
          :previous="props.previous"
          :busy="props.busy"
          :disabled="props.disabled"
          sheet
          class="flex-1"
          @approve="emit('approve', $event)"
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
        <AsyncTaskDetail
          v-if="flyout.ref.value"
          :task-ref="flyout.ref.value"
          mode="flyout"
          class="flex-1"
          @close="detailSheet = false"
        />
        <AsyncEpicDetail
          v-else-if="flyout.epic.value"
          :epic-id="flyout.epic.value"
          mode="flyout"
          class="flex-1"
          @close="detailSheet = false"
        />
      </div>
    </template>
  </UDrawer>
</template>
