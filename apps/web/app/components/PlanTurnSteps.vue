<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { runTranscriptQuery } from '~/queries/runs'
import { countSteps, withoutMessages } from '~/utils/tool-steps'

// A finished PM turn's work, collapsed above its reply (design/plan.md).
// The saved transcript loads the first time it's opened; `replies` are the
// turn's messages already in the log, left out so they aren't shown twice.
const props = defineProps<{ runId: string, replies: string[], agentName: string }>()

const open = ref(false)
const transcript = useQuery(computed(() => ({ ...runTranscriptQuery(props.runId), enabled: open.value })))
const events = transcript.data
const loading = computed(() => open.value && transcript.isPending.value)
const error = computed(() => transcript.error.value?.message ?? null)
const load = () => transcript.refetch()
const shown = computed(() => events.value ? withoutMessages(events.value, props.replies) : [])
const label = computed(() => {
  if (!events.value) return 'Steps'
  const n = countSteps(events.value)
  return n === 1 ? '1 step' : `${n} steps`
})

function toggle() {
  open.value = !open.value
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
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
      class="ms-2.5 min-w-0 border-s border-default ps-3.5"
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
