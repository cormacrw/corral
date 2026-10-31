<script setup lang="ts">
import type { PlanMessage } from '@corral/contracts'
import { api } from '~/composables/useApi'

const props = defineProps<{ message: PlanMessage }>()
const emit = defineEmits<{ resolved: [] }>()
const busy = ref(false)
const error = ref<string | null>(null)
const action = computed(() => props.message.pendingAction!)
async function decide(decision: 'confirm' | 'cancel') {
  if (busy.value || action.value.status !== 'pending') return
  busy.value = true
  error.value = null
  try {
    await api.plan.resolveAction(props.message.sessionId, props.message.id, decision)
    emit('resolved')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
const labels = { pending: 'Confirmation required', executing: 'Running…', confirmed: 'Confirmed', cancelled: 'Cancelled', failed: 'Could not confirm' }
</script>

<template>
  <section
    class="rounded-lg border border-default bg-elevated p-4 text-sm"
    aria-label="PM action confirmation"
    data-testid="pm-confirm-card"
  >
    <p class="mb-1 text-xs font-medium text-muted">
      {{ labels[action.status] }}
    </p>
    <p class="font-medium">
      {{ action.summary }}
    </p>
    <p
      v-if="action.status === 'pending'"
      class="mt-1 text-muted"
    >
      Nothing changes until you confirm.
    </p>
    <p
      v-if="action.error || error"
      role="alert"
      class="mt-2 text-error"
    >
      {{ action.error || error }}
    </p>
    <div class="mt-3 flex gap-2">
      <UButton
        label="Confirm"
        :loading="busy"
        :disabled="busy || action.status !== 'pending'"
        class="min-h-11"
        @click="decide('confirm')"
      />
      <UButton
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
