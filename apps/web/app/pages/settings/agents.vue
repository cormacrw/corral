<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query'
import type { Agent, AgentRuntime } from '@corral/contracts'
import type { api } from '~/composables/useApi'
import { agentsQuery, patchAgent as patchAgentMutation, setAgentAvatar } from '~/queries/agents'
import { clisQuery } from '~/queries/setup'
import { resumeAll as resumeAllMutation, statusQuery, stopAll as stopAllMutation } from '~/queries/system'
import { agentLimit } from '~/utils/agents'
import { detectedRuntimes, ROLE, runtimeLabel } from '~/utils/labels'

const device = useDevice()
const { data: agents } = useQuery(agentsQuery())
const { data: status } = useQuery(statusQuery())
const stopping = useMutation(stopAllMutation)
const resuming = useMutation(resumeAllMutation)
const agentPatch = useMutation(patchAgentMutation)
const agentAvatar = useMutation(setAgentAvatar)
const toast = useToast()
const cliScan = useQuery(clisQuery())
const clis = computed(() => cliScan.data.value ?? null)
const cliError = computed(() => cliScan.error.value?.message ?? null)
const adding = ref(false)
// Existing agents can switch to any detected runtime, keeping their current one listed
function runtimeItems(agent: Agent) {
  const values = new Set<string>([...detectedRuntimes(clis.value ?? []), agent.runtime])
  return [...values].map(value => ({ label: runtimeLabel(value), value }))
}

async function patchAgent(agent: Agent, input: Parameters<typeof api.agents.patch>[1]) {
  try {
    await agentPatch.mutateAsync({ id: agent.id, input })
    toast.add({ title: 'Saved', color: 'success' })
  } catch (e) {
    toast.add({ title: 'Not saved', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
// Shown in minutes; cleared means the agent wakes on every scheduler tick
function patchWakeInterval(agent: Agent, minutes: number | null | undefined) {
  const seconds = minutes ? Math.round(minutes * 60) : null
  if (seconds !== agent.wakeIntervalSeconds) void patchAgent(agent, { wakeIntervalSeconds: seconds })
}
async function saveAgentAvatar(agent: Agent, image: Blob | null) {
  await agentAvatar.mutateAsync({ id: agent.id, image })
}
async function stopAll() {
  try {
    await stopping.mutateAsync()
  } catch (e) {
    toast.add({ title: 'Could not stop', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
async function resumeAll() {
  try {
    await resuming.mutateAsync()
  } catch (e) {
    toast.add({ title: 'Could not resume', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
</script>

<template>
  <div :class="device.isMobile.value ? '' : 'flex flex-col gap-6'">
    <MobilePageHeader v-if="device.isMobile.value">
      <template #actions>
        <UButton
          label="Add agent"
          icon="i-lucide-plus"
          data-testid="add-agent"
          @click="adding = true"
        />
      </template>
    </MobilePageHeader>
    <SettingsAgentsMobile
      v-if="device.isMobile.value"
      :agents="agents ?? []"
      :stopped="status?.stopped ?? false"
      :runtime-items="runtimeItems"
      :patch-agent="patchAgent"
      :patch-wake-interval="patchWakeInterval"
      :save-avatar="saveAgentAvatar"
      @stop="stopAll"
      @resume="resumeAll"
    />
    <AgentForm
      v-if="device.isMobile.value"
      v-model:open="adding"
      :clis="clis"
      :cli-error="cliError"
    />
    <template v-else>
      <UCard>
        <template #header>
          <div class="flex items-start gap-3">
            <div class="flex-1">
              <h2 class="font-medium">
                Agents
              </h2>
              <p class="text-xs text-muted">
                Shared by every project. Each runs through your local CLI login; Corral never sees your credentials.
              </p>
            </div>
            <UButton
              label="Add agent"
              icon="i-lucide-plus"
              size="sm"
              data-testid="add-agent"
              @click="adding = true"
            />
          </div>
        </template>
        <ul class="divide-y divide-default">
          <li
            v-for="agent in agents"
            :key="agent.id"
            class="flex flex-wrap items-center gap-3 py-3"
          >
            <div class="min-w-0 flex-1 basis-48">
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ agent.name }}</span>
                <UBadge
                  :label="ROLE[agent.role]"
                  color="primary"
                  variant="subtle"
                  size="xs"
                />
              </div>
              <p class="text-xs text-muted">
                <span data-testid="agent-runtime-label">{{ runtimeLabel(agent.runtime) }}</span> · {{ agentLimit(agent) }} · <span class="font-mono">.corral/agents/{{ agent.role }}.md</span>
              </p>
              <AvatarUpload
                :name="agent.name"
                :avatar-url="agent.avatarUrl"
                size="lg"
                class="mt-2"
                :save="(image: Blob) => saveAgentAvatar(agent, image)"
                :remove="() => saveAgentAvatar(agent, null)"
              />
            </div>
            <UFormField
              label="Name"
              size="xs"
            >
              <UInput
                :model-value="agent.name"
                size="xs"
                class="w-32"
                @change="patchAgent(agent, { name: String(($event.target as HTMLInputElement).value).trim() })"
              />
            </UFormField>
            <UFormField
              v-if="agent.role !== 'pm'"
              label="Runtime"
              size="xs"
              :help="agent.activeRuns > 0 ? 'Changes once its runs end' : undefined"
            >
              <USelectMenu
                :model-value="agent.runtime"
                :items="runtimeItems(agent)"
                value-key="value"
                :search-input="false"
                :disabled="agent.activeRuns > 0"
                size="xs"
                class="w-28"
                @update:model-value="$event !== agent.runtime && patchAgent(agent, { runtime: $event as AgentRuntime })"
              />
            </UFormField>
            <UFormField
              v-if="agent.role !== 'pm'"
              label="Concurrency"
              size="xs"
            >
              <UInputNumber
                :model-value="agent.concurrency"
                :min="1"
                size="xs"
                class="w-28"
                @update:model-value="$event && patchAgent(agent, { concurrency: $event })"
              />
            </UFormField>
            <UFormField
              v-if="agent.role !== 'pm'"
              label="Wake interval (min)"
              size="xs"
              help="Blank: every check"
            >
              <UInputNumber
                :model-value="agent.wakeIntervalSeconds === null ? null : agent.wakeIntervalSeconds / 60"
                :min="1"
                placeholder="None"
                :aria-label="`Wake interval for ${agent.name} in minutes`"
                size="xs"
                class="w-28"
                @update:model-value="patchWakeInterval(agent, $event)"
              />
            </UFormField>
            <UFormField
              label="Paused"
              size="xs"
            >
              <USwitch
                :model-value="agent.paused"
                :aria-label="`Pause ${agent.name}`"
                @update:model-value="patchAgent(agent, { paused: $event })"
              />
            </UFormField>
          </li>
        </ul>
        <AgentForm
          v-model:open="adding"
          :clis="clis"
          :cli-error="cliError"
        />
      </UCard>
      <UCard :ui="{ root: 'ring-error/40' }">
        <template #header>
          <h2 class="font-medium text-error">
            Kill switch
          </h2>
        </template>
        <div class="grid gap-2 sm:grid-cols-[1fr_auto]">
          <div>
            <span class="font-medium">Stop everything</span>
            <p class="text-xs text-muted">
              Stops every live run and prevents new ones until you resume. Tasks keep their status and retry afterwards.
            </p>
          </div>
          <UButton
            v-if="status?.stopped"
            label="Resume everything"
            @click="resumeAll"
          />
          <UButton
            v-else
            label="Stop everything"
            color="error"
            @click="stopAll"
          />
        </div>
      </UCard>
    </template>
  </div>
</template>
