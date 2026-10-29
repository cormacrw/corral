<script setup lang="ts">
import type { Agent } from '@corral/contracts'
import { api, ApiError } from '~/composables/useApi'

// A big − n + control for a developer or reviewer agent's concurrency (the
// PM has none, see utils/agents.ts agentLimit). Each tap shows at once in the
// live state; quick taps go to the server as one PATCH after the last one.
const props = defineProps<{ agent: Pick<Agent, 'id' | 'name' | 'concurrency' | 'activeRuns'>, fullWidth?: boolean, compact?: boolean }>()

const SAVE_DELAY_MS = 600
const SAVED_NOTE_MS = 2000

const { state } = useLive()
const toast = useToast()

// What the server last confirmed, to go back to when a save fails
let saved = props.agent.concurrency
// The number on screen while taps wait to be sent
const pending = ref<number | null>(null)
const showSaved = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let revision = 0
let unmounted = false
let savedTimer: ReturnType<typeof setTimeout> | null = null

const value = computed(() => pending.value ?? props.agent.concurrency)

watch(() => props.agent.concurrency, (next) => {
  if (pending.value === null && !timer) saved = next
})

function show(concurrency: number): void {
  const live = state.value.agents.find(a => a.id === props.agent.id)
  if (live) live.concurrency = concurrency
}

function step(by: number): void {
  const next = value.value + by
  if (next < 1) return
  if (pending.value === null) saved = props.agent.concurrency
  revision++
  pending.value = next
  show(next)
  showSaved.value = false
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void save(), SAVE_DELAY_MS)
}

async function save(): Promise<void> {
  timer = null
  const concurrency = pending.value
  if (concurrency === null || inFlight) return
  inFlight = true
  const savingRevision = revision
  try {
    await api.agents.patch(props.agent.id, { concurrency })
    saved = concurrency
    // Keep newer optimistic taps visible until their own serialized write finishes.
    if (revision !== savingRevision) return
    pending.value = null
    show(concurrency)
    if (unmounted) return
    showSaved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      showSaved.value = false
    }, SAVED_NOTE_MS)
  } catch (e) {
    if (revision === savingRevision) {
      pending.value = null
      show(saved)
    }
    toast.add({ title: 'Not saved', description: e instanceof ApiError ? e.message : String(e), color: 'error' })
  } finally {
    inFlight = false
    // A debounce that expired during this request is ready now. Otherwise
    // leave the newer taps' timer alone so they still get the full 600ms.
    if (revision !== savingRevision && !timer) void save()
  }
}

onBeforeUnmount(() => {
  unmounted = true
  if (savedTimer) clearTimeout(savedTimer)
  // Don't drop taps waiting to be sent
  if (timer) {
    clearTimeout(timer)
    void save()
  }
})
</script>

<template>
  <div :class="['flex items-center', compact ? 'flex-col gap-1' : 'gap-3']">
    <div :class="['flex flex-col items-center', fullWidth && 'w-full']">
      <div :class="['flex items-center', compact ? 'gap-1' : 'gap-2', fullWidth && 'w-full justify-between']">
        <UButton
          icon="i-lucide-minus"
          color="neutral"
          variant="outline"
          size="xl"
          class="size-11 justify-center"
          :disabled="value <= 1"
          :aria-label="`Decrease concurrency for ${props.agent.name}`"
          @click="step(-1)"
        />
        <span
          :class="['text-center font-semibold text-highlighted tabular-nums', compact ? 'min-w-6 text-base' : 'min-w-10 text-2xl']"
          aria-live="polite"
          data-testid="concurrency"
        >{{ value }}</span>
        <UButton
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          size="xl"
          class="size-11 justify-center"
          :aria-label="`Increase concurrency for ${props.agent.name}`"
          @click="step(1)"
        />
      </div>
      <p
        v-if="props.agent.activeRuns > 0"
        class="text-xs text-muted"
      >
        {{ props.agent.activeRuns }} running now
      </p>
    </div>
    <span
      v-if="showSaved"
      class="text-xs text-muted"
      role="status"
    >Saved</span>
  </div>
</template>
