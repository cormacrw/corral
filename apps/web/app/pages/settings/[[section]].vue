<script setup lang="ts">
import type { Agent, AgentRuntime, CliStatus } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { parseOverride } from '~/utils/device'
import { cliLoginCommand, detectedRuntimes, ROLE, runtimeLabel, timeAgo } from '~/utils/labels'

// Global settings (design/settings.md): profile, agents, runner, appearance
const route = useRoute()
const live = useLive()
const toast = useToast()
const colorMode = useColorMode()
const device = useDevice()
const install = useInstall()
const section = computed(() => (typeof route.params.section === 'string' ? route.params.section : 'profile'))
useSeoMeta({ title: 'Settings · Corral' })

// Kept on the server with the picture, so every browser shows the same name
const userName = ref(live.state.value.profile?.name ?? '')
watch(() => live.state.value.profile?.name, (name) => {
  if (name !== undefined) userName.value = name
})
async function saveName() {
  const name = userName.value.trim()
  if (name === live.state.value.profile?.name) return
  try {
    live.state.value.profile = await api.me.patch({ name })
    toast.add({ title: 'Saved', color: 'success' })
  } catch (e) {
    toast.add({ title: 'Not saved', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
const clis = ref<CliStatus[] | null>(null)
const cliError = ref<string | null>(null)
async function scan() {
  cliError.value = null
  try {
    clis.value = await api.setup.clis()
  } catch (e) {
    cliError.value = e instanceof Error ? e.message : String(e)
  }
}
// The runner page shows the logins; the agents page needs them for the runtime menu
watch(section, (s) => {
  if (s === 'runner' || s === 'agents') void scan()
}, { immediate: true })

const adding = ref(false)
// The live agent.updated event adds it too; this covers a slow stream
function added(agent: Agent) {
  if (!live.state.value.agents.some(a => a.id === agent.id)) live.state.value.agents = [...live.state.value.agents, agent]
}
// Existing agents can switch to any detected runtime, keeping their current one listed
function runtimeItems(agent: Agent) {
  const values = new Set<string>([...detectedRuntimes(clis.value ?? []), agent.runtime])
  return [...values].map(value => ({ label: runtimeLabel(value), value }))
}

async function patchAgent(agent: Agent, input: Parameters<typeof api.agents.patch>[1]) {
  try {
    await api.agents.patch(agent.id, input)
    toast.add({ title: 'Saved', color: 'success' })
  } catch (e) {
    toast.add({ title: 'Not saved', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
async function saveMyAvatar(image: Blob | null) {
  live.state.value.profile = image ? await api.me.setAvatar(image) : await api.me.clearAvatar()
}
async function saveAgentAvatar(agent: Agent, image: Blob | null) {
  const updated = image ? await api.agents.setAvatar(agent.id, image) : await api.agents.clearAvatar(agent.id)
  live.state.value.agents = live.state.value.agents.map(a => a.id === updated.id ? updated : a)
}
async function stopAll() {
  try {
    await api.stopAll()
  } catch (e) {
    toast.add({ title: 'Could not stop', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
async function resumeAll() {
  try {
    await api.resumeAll()
  } catch (e) {
    toast.add({ title: 'Could not resume', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
const items = [
  { label: 'Profile', to: '/settings/profile', icon: 'i-lucide-user' },
  { label: 'Agents', to: '/settings/agents', icon: 'i-lucide-bot' },
  { label: 'Runner', to: '/settings/runner', icon: 'i-lucide-server' },
  { label: 'Appearance', to: '/settings/appearance', icon: 'i-lucide-palette' }
]
</script>

<template>
  <UDashboardPanel>
    <div class="mx-auto flex w-full max-w-[1100px] gap-8 p-6 max-[800px]:flex-col">
      <aside class="w-56 shrink-0 max-[800px]:w-full">
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
              :avatar-url="live.state.value.profile?.avatarUrl ?? null"
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
                v-for="agent in live.state.value.agents"
                :key="agent.id"
                class="flex flex-wrap items-center gap-3 py-3"
              >
                <div class="min-w-0 flex-1 basis-56">
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
                    <span data-testid="agent-runtime">{{ runtimeLabel(agent.runtime) }}</span> · concurrency {{ agent.concurrency }} · <span class="font-mono">.corral/agents/{{ agent.role }}.md</span>
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
                  label="Concurrency"
                  size="xs"
                >
                  <UInputNumber
                    :model-value="agent.concurrency"
                    :min="1"
                    size="xs"
                    @update:model-value="$event && patchAgent(agent, { concurrency: $event })"
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
              @created="added"
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
                v-if="live.state.value.status.stopped"
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
              Runner
            </h2>
          </template>
          <div class="flex flex-col gap-4 text-sm">
            <div class="flex items-center gap-2">
              <span
                :class="['size-2.5 rounded-full', live.state.value.runner?.online ? 'bg-success' : 'bg-error']"
                aria-hidden="true"
              />
              <span class="font-medium">{{ live.state.value.runner?.online ? 'Online' : 'Offline' }} · {{ live.state.value.runner?.name ?? 'no runner yet' }}</span>
              <span class="text-xs text-muted">Runs agents for every project · last heartbeat {{ timeAgo(live.state.value.runner?.lastHeartbeatAt) }}</span>
            </div>
            <p class="text-xs text-muted">
              The runner keeps clones, worktrees and its spool in its own data directory, set by its configuration (a Docker volume when deployed).
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
                Primary colour and font are set in app.config.ts and main.css for now.
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
