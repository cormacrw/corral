import { errorText } from '@corral/core'
import { useMutation, useQuery } from '@tanstack/vue-query'
import type { Agent, PatchAgentInput } from '@corral/contracts'
import { agentsQuery, patchAgent as patchAgentMutation, setAgentAvatar } from '~/queries/agents'
import { resumeAll as resumeAllMutation, statusQuery, stopAll as stopAllMutation } from '~/queries/system'
import { detectedRuntimes, runtimeLabel } from '~/utils/labels'

// Settings → Agents, shared by the desktop list and the mobile cards
export function useAgentSettings() {
  const { data: agents } = useQuery(agentsQuery())
  const { data: status } = useQuery(statusQuery())
  const { clis, cliError } = useCliScan()
  const stopping = useMutation(stopAllMutation)
  const resuming = useMutation(resumeAllMutation)
  const agentPatch = useMutation(patchAgentMutation)
  const agentAvatar = useMutation(setAgentAvatar)
  const toast = useToast()

  const stopped = computed(() => status.value?.stopped ?? false)

  // Existing agents can switch to any detected runtime, keeping their current one listed
  function runtimeItems(agent: Agent) {
    const values = new Set<string>([...detectedRuntimes(clis.value ?? []), agent.runtime])
    return [...values].map(value => ({ label: runtimeLabel(value), value }))
  }

  async function patchAgent(agent: Agent, input: PatchAgentInput) {
    try {
      await agentPatch.mutateAsync({ id: agent.id, input })
      toast.add({ title: 'Saved', color: 'success' })
    } catch (e) {
      toast.add({ title: 'Not saved', description: errorText(e), color: 'error' })
    }
  }
  // A blank name is refused, so the field goes back to the one it had
  function renameAgent(agent: Agent, event: Event) {
    const input = event.target as HTMLInputElement
    const name = input.value.trim()
    if (name) void patchAgent(agent, { name })
    else input.value = agent.name
  }
  // Shown in minutes; cleared means the agent wakes on every scheduler tick
  function patchWakeInterval(agent: Agent, minutes: number | null | undefined) {
    const seconds = minutes ? Math.round(minutes * 60) : null
    if (seconds !== agent.wakeIntervalSeconds) void patchAgent(agent, { wakeIntervalSeconds: seconds })
  }
  async function saveAvatar(agent: Agent, image: Blob | null) {
    await agentAvatar.mutateAsync({ id: agent.id, image })
  }

  async function stopAll() {
    try {
      await stopping.mutateAsync()
    } catch (e) {
      toast.add({ title: 'Could not stop', description: errorText(e), color: 'error' })
    }
  }
  async function resumeAll() {
    try {
      await resuming.mutateAsync()
    } catch (e) {
      toast.add({ title: 'Could not resume', description: errorText(e), color: 'error' })
    }
  }

  return { agents, stopped, clis, cliError, runtimeItems, patchAgent, renameAgent, patchWakeInterval, saveAvatar, stopAll, resumeAll }
}

export type AgentSettings = ReturnType<typeof useAgentSettings>
