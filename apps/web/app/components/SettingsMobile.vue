<script setup lang="ts">
import { agentLimit } from '~/utils/agents'
import { parseOverride } from '~/utils/device'
import { ROLE, runtimeLabel } from '~/utils/labels'

// Settings on mobile (design/settings.md, design/mobile.md): one screen that
// lists the sections, each opening its own screen, with Appearance (colour
// mode and the layout override) set right here
const live = useLive()
const state = live.state
const colorMode = useColorMode()
const device = useDevice()
const install = useInstall()
const name = computed(() => state.value.profile?.name || 'You')
</script>

<template>
  <div class="flex flex-col gap-2 pb-8">
    <NuxtLink
      to="/settings/profile"
      class="flex items-center gap-4 px-4 pt-4 pb-2"
    >
      <AgentAvatar
        :name="name"
        :src="state.profile?.avatarUrl ?? null"
        size="3xl"
      />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-lg font-semibold text-highlighted">{{ name }}</span>
        <span class="block text-sm text-muted">How agents address you, and the author on approvals</span>
      </span>
    </NuxtLink>

    <ul class="divide-y divide-default border-y border-default">
      <li>
        <NuxtLink
          to="/settings/profile"
          class="flex min-h-14 items-center gap-3 px-4 py-3"
        >
          <UIcon
            name="i-lucide-user"
            class="size-5 shrink-0 text-muted"
          />
          <span class="flex-1 text-highlighted">Profile</span>
          <UIcon
            name="i-lucide-chevron-right"
            class="size-4 shrink-0 text-dimmed"
          />
        </NuxtLink>
      </li>
      <li>
        <NuxtLink
          to="/settings/runner"
          class="flex min-h-14 items-center gap-3 px-4 py-3"
          data-testid="settings-runner"
        >
          <UIcon
            name="i-lucide-server"
            class="size-5 shrink-0 text-muted"
          />
          <span class="min-w-0 flex-1">
            <span class="block text-highlighted">Runner</span>
            <span class="block truncate text-xs text-muted">{{ state.runner?.online ? 'Online' : 'Offline' }} · {{ state.runner?.name ?? 'no runner yet' }}</span>
          </span>
          <span
            :class="['size-2.5 shrink-0 rounded-full', state.runner?.online ? 'bg-success' : 'bg-error']"
            aria-hidden="true"
          />
          <UIcon
            name="i-lucide-chevron-right"
            class="size-4 shrink-0 text-dimmed"
          />
        </NuxtLink>
      </li>
    </ul>

    <div class="flex items-baseline justify-between px-4 pt-4">
      <h2 class="text-sm font-semibold text-highlighted">
        Agents
      </h2>
      <span class="text-xs text-muted">Shared by every project</span>
    </div>
    <ul class="divide-y divide-default border-y border-default">
      <li
        v-for="agent in state.agents"
        :key="agent.id"
      >
        <NuxtLink
          to="/settings/agents"
          class="flex min-h-14 items-center gap-3 px-4 py-3"
        >
          <AgentAvatar
            :name="agent.name"
            size="md"
          />
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="font-medium text-highlighted">{{ agent.name }}</span>
              <UBadge
                :label="ROLE[agent.role]"
                color="primary"
                variant="subtle"
                size="xs"
              />
              <UBadge
                v-if="agent.paused"
                label="Paused"
                color="neutral"
                variant="subtle"
                size="xs"
              />
            </span>
            <span class="block truncate text-xs text-muted">{{ runtimeLabel(agent.runtime) }} · {{ agentLimit(agent) }}</span>
          </span>
          <UIcon
            name="i-lucide-chevron-right"
            class="size-4 shrink-0 text-dimmed"
          />
        </NuxtLink>
      </li>
    </ul>
    <p class="px-4 text-xs text-muted">
      Each runs through your local CLI login; Corral never sees your credentials.
    </p>

    <h2 class="px-4 pt-4 text-sm font-semibold text-highlighted">
      Appearance
    </h2>
    <div class="flex flex-col gap-3 px-4">
      <UTabs
        :model-value="colorMode.preference"
        :items="[{ label: 'System', value: 'system' }, { label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }]"
        size="lg"
        :content="false"
        aria-label="Colour mode"
        @update:model-value="colorMode.preference = String($event)"
      />
      <div>
        <p class="mb-1.5 text-sm text-highlighted">
          Dark background
        </p>
        <DarkNeutralPicker />
        <p class="mt-1.5 text-xs text-muted">
          Dark mode only. Saved for this device only.
        </p>
      </div>
      <div>
        <p class="mb-1.5 text-sm text-highlighted">
          Layout
        </p>
        <UTabs
          :model-value="device.override.value"
          :items="[{ label: 'Auto', value: 'auto' }, { label: 'Desktop', value: 'desktop' }, { label: 'Mobile', value: 'mobile' }]"
          size="lg"
          :content="false"
          aria-label="Layout"
          data-testid="layout-override"
          @update:model-value="device.setOverride(parseOverride($event))"
        />
        <p class="mt-1.5 text-xs text-muted">
          Auto uses the mobile layout on a phone or the installed app. Saved for this device only.
        </p>
      </div>
    </div>

    <!-- Only where the browser can install it, and not once installed -->
    <template v-if="install.mode.value">
      <h2 class="px-4 pt-4 text-sm font-semibold text-highlighted">
        App
      </h2>
      <ul class="divide-y divide-default border-y border-default">
        <li>
          <button
            type="button"
            class="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-start"
            data-testid="open-install"
            @click="install.open.value = true"
          >
            <UIcon
              name="i-lucide-square-plus"
              class="size-5 shrink-0 text-muted"
            />
            <span class="min-w-0 flex-1">
              <span class="block text-highlighted">Install Corral</span>
              <span class="block text-xs text-muted">Add it to your home screen</span>
            </span>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 shrink-0 text-dimmed"
            />
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>
