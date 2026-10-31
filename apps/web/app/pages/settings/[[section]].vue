<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query'
import type { Agent, AgentRuntime } from '@corral/contracts'
import type { api } from '~/composables/useApi'
import { agentsQuery, patchAgent as patchAgentMutation, setAgentAvatar } from '~/queries/agents'
import { clisQuery } from '~/queries/setup'
import { patchProfile, profileQuery, resumeAll as resumeAllMutation, setProfileAvatar, statusQuery, stopAll as stopAllMutation } from '~/queries/system'
import { agentLimit } from '~/utils/agents'
import { parseOverride } from '~/utils/device'
import { cliLoginCommand, detectedRuntimes, ROLE, runtimeLabel } from '~/utils/labels'

definePageMeta({ key: 'settings' })

// Global settings (design/settings.md): profile, agents, runner, appearance
const route = useRoute()
const { data: profile } = useQuery(profileQuery())
const { data: agents } = useQuery(agentsQuery())
const { data: status } = useQuery(statusQuery())
const stopping = useMutation(stopAllMutation)
const resuming = useMutation(resumeAllMutation)
const profilePatch = useMutation(patchProfile)
const profileAvatar = useMutation(setProfileAvatar)
const agentPatch = useMutation(patchAgentMutation)
const agentAvatar = useMutation(setAgentAvatar)
const toast = useToast()
const colorMode = useColorMode()
const device = useDevice()
const install = useInstall()
// On mobile, /settings is the list of sections; on the web it opens Profile
const section = computed(() => (typeof route.params.section === 'string' ? route.params.section : device.isMobile.value ? null : 'profile'))
useSeoMeta({ title: 'Settings · Corral' })

// Kept on the server with the picture, so every browser shows the same name
const userName = ref(profile.value?.name ?? '')
watch(() => profile.value?.name, (name) => {
  if (name !== undefined) userName.value = name
})
async function saveName() {
  const name = userName.value.trim()
  if (name === profile.value?.name) return
  try {
    await profilePatch.mutateAsync({ name })
    toast.add({ title: 'Saved', color: 'success' })
  } catch (e) {
    toast.add({ title: 'Not saved', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
// The runner page shows the logins; the agents page needs them for the runtime menu
const cliScan = useQuery(computed(() => ({ ...clisQuery(), enabled: section.value === 'runner' || section.value === 'agents' })))
const clis = computed(() => cliScan.data.value ?? null)
const cliError = computed(() => cliScan.error.value?.message ?? null)
const scan = () => cliScan.refetch()

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
async function saveMyAvatar(image: Blob | null) {
  await profileAvatar.mutateAsync(image)
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
const items = [
  { label: 'Profile', to: '/settings/profile', icon: 'i-lucide-user' },
  { label: 'Agents', to: '/settings/agents', icon: 'i-lucide-bot' },
  { label: 'Runners', to: '/settings/runner', icon: 'i-lucide-server' },
  { label: 'Appearance', to: '/settings/appearance', icon: 'i-lucide-palette' }
]
</script>

<template>
  <UDashboardPanel
    v-if="device.isMobile.value && (section === null || section === 'runner' || section === 'agents')"
    :ui="{ body: 'p-0 sm:p-0 gap-0 sm:gap-0' }"
  >
    <template #body>
      <MobilePageHeader v-if="section !== null">
        <template
          v-if="section === 'agents'"
          #actions
        >
          <UButton
            label="Add agent"
            icon="i-lucide-plus"
            data-testid="add-agent"
            @click="adding = true"
          />
        </template>
      </MobilePageHeader>
      <SettingsMobile v-if="section === null" />
      <SettingsAgentsMobile
        v-else-if="section === 'agents'"
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
        v-if="section === 'agents'"
        v-model:open="adding"
        :clis="clis"
        :cli-error="cliError"
      />
      <SettingsRunnerMobile
        v-if="section === 'runner'"
        :clis="clis"
        :cli-error="cliError"
        @scan="scan"
      />
    </template>
  </UDashboardPanel>
  <UDashboardPanel v-else>
    <MobilePageHeader v-if="device.isMobile.value" />
    <!-- On mobile each section is its own screen, so the menu is the Settings list -->
    <div :class="['mx-auto flex w-full max-w-[1100px] gap-8 max-[800px]:flex-col', device.isMobile.value ? 'p-4' : 'p-6']">
      <aside
        v-if="!device.isMobile.value"
        class="w-56 shrink-0 max-[800px]:w-full"
      >
        <h1 class="mb-2 text-lg font-semibold">
          Settings
        </h1>
        <UNavigationMenu
          :items="items"
          orientation="vertical"
        />
        <p class="mt-3 text-xs text-muted">
          Settings here apply to every project. Each project has its own settings in the sidebar.
        </p>
        <!-- Only where the browser can install it, and not once installed -->
        <template v-if="install.mode.value">
          <h2 class="mt-6 mb-2 text-xs font-semibold text-muted">
            App
          </h2>
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-start hover:bg-elevated/50"
            data-testid="open-install"
            @click="install.open.value = true"
          >
            <UIcon
              name="i-lucide-square-plus"
              class="size-5 shrink-0 text-muted"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="text-sm text-highlighted">Install Corral</span>
              <span class="text-xs text-muted">Add it to your home screen</span>
            </span>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 shrink-0 text-dimmed"
            />
          </button>
        </template>
      </aside>

      <div class="flex min-w-0 max-w-[880px] flex-1 flex-col gap-6">
        <UCard v-if="section === 'profile'">
          <template #header>
            <h2 class="font-medium">
              Profile
            </h2>
          </template>
          <div class="mb-5 grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <span class="font-medium">Picture</span>
              <p class="text-xs text-muted">
                Shown on your comments, approvals and in the sidebar. Cropped to a square.
              </p>
            </div>
            <AvatarUpload
              name="You"
              :avatar-url="profile?.avatarUrl ?? null"
              :save="(image: Blob) => saveMyAvatar(image)"
              :remove="() => saveMyAvatar(null)"
            />
          </div>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <label
                for="yourName"
                class="font-medium"
              >Your name</label>
              <p class="text-xs text-muted">
                How agents address you.
              </p>
            </div>
            <UInput
              id="yourName"
              v-model="userName"
              :maxlength="80"
              @change="saveName"
            />
          </div>
        </UCard>

        <template v-else-if="section === 'agents'">
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

        <UCard v-else-if="section === 'runner'">
          <template #header>
            <h2 class="font-medium">
              Runners
            </h2>
          </template>
          <div class="flex flex-col gap-4 text-sm">
            <RunnerList />
            <p class="text-xs text-muted">
              Each runner keeps clones, worktrees and its spool in its own data directory, set by its configuration (a Docker volume when deployed).
            </p>
            <div>
              <div class="mb-1 flex items-center gap-2">
                <span class="font-medium">Logins</span>
                <UButton
                  label="Scan again"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  @click="scan"
                />
              </div>
              <UAlert
                v-if="cliError"
                color="warning"
                variant="subtle"
                :title="cliError"
              />
              <ul
                v-else-if="clis"
                class="flex flex-col gap-1"
              >
                <li
                  v-for="cli in clis"
                  :key="cli.id"
                  class="flex flex-wrap items-center gap-2"
                  :data-testid="`cli-${cli.id}`"
                >
                  <UBadge
                    :label="cli.signedIn ? 'Signed in' : 'Not signed in'"
                    :color="cli.signedIn ? 'success' : 'warning'"
                    variant="subtle"
                    size="xs"
                  />
                  <span>{{ cli.name }} {{ cli.version ?? '(not found)' }}</span>
                  <code
                    v-if="cli.version && !cli.signedIn"
                    class="font-mono text-xs text-muted"
                  >{{ cliLoginCommand(cli.id) }}</code>
                </li>
              </ul>
              <USkeleton
                v-else
                class="h-5 w-48"
              />
              <p class="mt-2 text-xs text-muted">
                Sign in inside the runner container: <code class="font-mono">{{ cliLoginCommand('claude') }}</code>, <code class="font-mono">{{ cliLoginCommand('codex') }}</code> and <code class="font-mono">docker exec -it corral-runner gh auth login</code>. Corral shows the state only and never reads the credentials.
              </p>
            </div>
          </div>
        </UCard>

        <UCard v-else-if="section === 'appearance'">
          <template #header>
            <h2 class="font-medium">
              Appearance
            </h2>
          </template>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <span class="font-medium">Colour mode</span>
              <p class="text-xs text-muted">
                Primary colour, light palette and font are configured in app.config.ts and main.css.
              </p>
            </div>
            <UTabs
              :model-value="colorMode.preference"
              :items="[{ label: 'System', value: 'system' }, { label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }]"
              size="sm"
              :content="false"
              @update:model-value="colorMode.preference = String($event)"
            />
          </div>
          <div class="mt-5 grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <span class="font-medium">Dark background</span>
              <p class="text-xs text-muted">
                Background, surfaces and borders in dark mode. Saved for this device only.
              </p>
            </div>
            <DarkNeutralPicker />
          </div>
          <div class="mt-5 grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <span class="font-medium">Layout</span>
              <p class="text-xs text-muted">
                Auto uses the mobile layout on a phone or the installed app. Saved for this device only.
              </p>
            </div>
            <UTabs
              :model-value="device.override.value"
              :items="[{ label: 'Auto', value: 'auto' }, { label: 'Desktop', value: 'desktop' }, { label: 'Mobile', value: 'mobile' }]"
              size="sm"
              :content="false"
              data-testid="layout-override"
              @update:model-value="device.setOverride(parseOverride($event))"
            />
          </div>
        </UCard>
      </div>
    </div>
  </UDashboardPanel>
</template>
