<script setup lang="ts">
import type { RunnerInfo } from '@corral/contracts'
import { api } from '~/composables/useApi'

const props = defineProps<{ runner: RunnerInfo }>()
const pending = ref(false)
const error = ref('')
const label = computed(() => {
  const r = props.runner
  if (r.updateState === 'failed') return `Update failed · ${r.updateError || 'Please retry'}`
  if (!r.online && (r.draining || r.updateRequested)) return 'Updating · offline'
  if (r.draining && (r.activeRunCount ?? 0) > 0) return `Draining · ${r.activeRunCount} runs left`
  if (r.updateState === 'building') return 'Building update'
  if (r.draining) return 'Waiting for updater'
  if (r.behind) return 'Behind server'
  return `Up to date · ${r.commit.slice(0, 7)}`
})
async function update() {
  pending.value = true
  error.value = ''
  try {
    await api.updateRunner(props.runner.id)
    await useLive().load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Update request failed'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-2 text-xs"
    aria-live="polite"
  >
    <span :class="runner.updateState === 'failed' ? 'text-error' : 'text-muted'">{{ label }}</span>
    <span
      v-if="runner.behind"
      class="text-muted"
    >{{ runner.commit.slice(0, 7) }} → {{ runner.serverCommit.slice(0, 7) }}</span>
    <UButton
      v-if="runner.behind && runner.online && !runner.draining"
      label="Update now"
      size="xs"
      variant="soft"
      :loading="pending"
      @click="update"
    />
    <span
      v-if="error"
      class="text-error"
    >{{ error }}</span>
  </div>
</template>
