import { useMutation, useQueryClient } from '@tanstack/vue-query'
import type { Agent } from '@corral/contracts'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSavedNote } from '~/composables/useSavedNote'
import { errorMessage } from '~/lib/errors'
import { patchAgent } from '~/queries/agents'
import { keys } from '~/queries/keys'

// Editing a developer or reviewer agent's concurrency (the PM has none, see
// utils/agents.ts agentLimit), for the stepper and the settings field alike.
// Each change shows at once in the agent list; quick changes go to the server
// as one PATCH after the last one, and a failure puts back what was saved.
const SAVE_DELAY_MS = 600

export function useConcurrency(agent: () => Pick<Agent, 'id' | 'concurrency'>) {
  const client = useQueryClient()
  const toast = useToast()
  const patch = useMutation(patchAgent)

  // What the server last confirmed, to go back to when a save fails
  let saved = agent().concurrency
  // The number on screen while taps wait to be sent
  const pending = ref<number | null>(null)
  const { saved: showSaved, flash: flashSaved, clear: clearSaved } = useSavedNote()
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let revision = 0
  let unmounted = false

  const value = computed(() => pending.value ?? agent().concurrency)

  watch(() => agent().concurrency, (next) => {
    if (pending.value === null && !timer) saved = next
  })

  function show(concurrency: number): void {
    client.setQueryData<Agent[]>(keys.agents.list(), agents => agents?.map(a => a.id === agent().id ? { ...a, concurrency } : a))
  }

  function set(next: number): void {
    if (next < 1 || next === value.value) return
    if (pending.value === null) saved = agent().concurrency
    revision++
    pending.value = next
    show(next)
    clearSaved()
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
      await patch.mutateAsync({ id: agent().id, input: { concurrency } })
      saved = concurrency
      // Keep newer optimistic taps visible until their own serialized write finishes.
      if (revision !== savingRevision) return
      pending.value = null
      show(concurrency)
      if (!unmounted) flashSaved()
    } catch (e) {
      if (revision === savingRevision) {
        pending.value = null
        show(saved)
      }
      toast.add({ title: 'Not saved', description: errorMessage(e), color: 'error' })
    } finally {
      inFlight = false
      // A debounce that expired during this request is ready now. Otherwise
      // leave the newer taps' timer alone so they still get the full 600ms.
      if (revision !== savingRevision && !timer) void save()
    }
  }

  onBeforeUnmount(() => {
    unmounted = true
    // Don't drop taps waiting to be sent
    if (timer) {
      clearTimeout(timer)
      void save()
    }
  })

  return { value, showSaved, set, step: (by: number) => set(value.value + by) }
}
