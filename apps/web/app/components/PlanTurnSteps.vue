<script setup lang="ts">
import type { RunEvent } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { countSteps, withoutMessages } from '~/utils/tool-steps'

// A finished PM turn's work, collapsed above its reply (design/plan.md).
// The saved transcript loads the first time it's opened; `replies` are the
// turn's messages already in the log, left out so they aren't shown twice.
const props = defineProps<{ runId: string, replies: string[], agentName: string }>()

const open = ref(false)
const events = ref<RunEvent[] | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const shown = computed(() => events.value ? withoutMessages(events.value, props.replies) : [])
const label = computed(() => {
  if (!events.value) return 'Steps'
  const n = countSteps(events.value)
  return n === 1 ? '1 step' : `${n} steps`
})

async function load() {
  loading.value = true
  error.value = null
  try {
    events.value = await api.runs.transcript(props.runId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
async function toggle() {
  open.value = !open.value
  if (open.value && !events.value && !loading.value) await load()
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <button
      type="button"
      class="flex items-center gap-1.5 self-start rounded-md py-0.5 ps-1 pe-2 text-xs text-muted hover:bg-elevated"
      :aria-expanded="open"
      @click="toggle"
    >
      <UIcon
        :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        class="size-3.5 shrink-0 text-dimmed"
      />
      {{ label }}
      <UIcon
        v-if="loading"
        name="i-lucide-loader-circle"
        class="size-3.5 shrink-0 animate-spin text-dimmed motion-reduce:animate-none"
      />
    </button>
    <div
      v-if="open && (events || error)"
      class="ms-2.5 border-s border-default ps-3.5"
    >
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error"
        :actions="[{ label: 'Retry', onClick: load }]"
      />
      <RunTranscript
        v-else
        :events="shown"
        :live="false"
        :agent-name="props.agentName"
        inline
      />
    </div>
  </div>
</template>
