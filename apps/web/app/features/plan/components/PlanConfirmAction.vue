<script setup lang="ts">
import { errorText } from '@corral/core'
import type { PlanMessage, PmActionDecision } from '@corral/contracts'
import { useMutation } from '@tanstack/vue-query'
import { resolvePlanAction } from '~/queries/plan'

const props = defineProps<{ message: PlanMessage }>()
const resolve = useMutation(resolvePlanAction)
const busy = ref(false)
const error = ref<string | null>(null)
const action = computed(() => props.message.pendingAction!)
async function decide(decision: PmActionDecision) {
  if (busy.value || action.value.status !== 'pending') return
  busy.value = true
  error.value = null
  try {
    await resolve.mutateAsync({ sessionId: props.message.sessionId, messageId: props.message.id, decision })
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
const labels = { pending: 'Confirmation required', executing: 'Running…', confirmed: 'Confirmed', cancelled: 'Cancelled', failed: 'Could not confirm' }
</script>

<template>
  <section
    class="rounded-lg border border-border bg-muted p-4 text-sm"
    aria-label="PM action confirmation"
    data-testid="pm-confirm-card"
  >
    <p class="mb-1 text-xs font-medium text-muted-foreground">
      {{ labels[action.status] }}
    </p>
    <p class="font-medium">
      {{ action.summary }}
    </p>
    <p
      v-if="action.status === 'pending'"
      class="mt-1 text-muted-foreground"
    >
      Nothing changes until you confirm.
    </p>
    <p
      v-if="action.error || error"
      role="alert"
      class="mt-2 text-destructive"
    >
      {{ action.error || error }}
    </p>
    <div class="mt-3 flex gap-2">
      <AppButton
        label="Confirm"
        :loading="busy"
        :disabled="busy || action.status !== 'pending'"
        class="min-h-11"
        @click="decide('confirm')"
      />
      <AppButton
        label="Cancel"
        color="neutral"
        variant="outline"
        :disabled="busy || action.status !== 'pending'"
        class="min-h-11"
        @click="decide('cancel')"
      />
    </div>
  </section>
</template>
