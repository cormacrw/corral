<script setup lang="ts">
import { ROLE_LABELS } from '@corral/core'
import { useQuery } from '@tanstack/vue-query'
import { agentsQuery } from '~/queries/agents'
import { profileQuery, runnerQuery } from '~/queries/system'
import { runnerSummary, runtimeLabel } from '~/utils/labels'
import { settingsPath, settingsSection } from '~/utils/routes'

// Settings on mobile (design/settings.md, design/mobile.md): one screen that
// lists the sections, each opening its own screen, with Appearance (colour
// mode and the layout override) set right here
const { data: profile } = useQuery(profileQuery())
const { data: runner } = useQuery(runnerQuery())
const { data: agents } = useQuery(agentsQuery())
const install = useInstall()
const name = computed(() => profile.value?.name || 'You')
const row = (section: 'profile' | 'runner' | 'performance') => {
  const { label, icon } = settingsSection(section)!
  return { to: settingsPath(section), label, icon }
}
const runnerStatus = computed(() => `${runner.value?.online ? 'Online' : 'Offline'} · ${runnerSummary(runner.value ?? null)}`)
</script>

<template>
  <div class="flex flex-col gap-2 pb-8">
    <NuxtLink
      :to="settingsPath('profile')"
      class="flex items-center gap-4 px-4 pt-4 pb-2"
    >
      <AgentAvatar
        :name="name"
        :src="profile?.avatarUrl ?? null"
        size="3xl"
      />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-lg font-semibold text-foreground">{{ name }}</span>
        <span class="block text-sm text-muted-foreground">How agents address you, and the author on approvals</span>
      </span>
    </NuxtLink>

    <ul class="divide-y divide-border border-y border-border">
      <li>
        <SettingsRow
          v-bind="row('profile')"
        />
      </li>
      <li>
        <SettingsRow
          v-bind="row('runner')"
          :description="runnerStatus"
          data-testid="settings-runner"
        >
          <template #trailing>
            <span
              :class="['size-2.5 shrink-0 rounded-full', runner?.online ? 'bg-success' : 'bg-destructive']"
              aria-hidden="true"
            />
          </template>
        </SettingsRow>
      </li>
      <li>
        <SettingsRow
          v-bind="row('performance')"
          data-testid="settings-performance"
        />
      </li>
    </ul>

    <div class="flex items-baseline justify-between px-4 pt-4">
      <h2 class="text-sm font-semibold text-foreground">
        Agents
      </h2>
      <span class="text-xs text-muted-foreground">Shared by every project</span>
    </div>
    <ul class="divide-y divide-border border-y border-border">
      <li
        v-for="agent in agents"
        :key="agent.id"
        class="flex items-center gap-2 pr-4"
      >
        <NuxtLink
          :to="`${settingsPath('agents')}#agent-${agent.id}`"
          class="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-3 pl-4"
        >
          <AgentAvatar
            :name="agent.name"
            size="md"
          />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="truncate font-medium text-foreground">{{ agent.name }}</span>
              <AppBadge
                :label="ROLE_LABELS[agent.role]"
                color="primary"
                variant="subtle"
                size="xs"
              />
              <AppBadge
                v-if="agent.paused"
                label="Paused"
                color="neutral"
                variant="subtle"
                size="xs"
              />
            </span>
            <span class="block truncate text-xs text-muted-foreground">{{ runtimeLabel(agent.runtime) }}<template v-if="agent.role === 'pm'"> · one turn per session</template></span>
          </span>
          <Icon
            v-if="agent.role === 'pm'"
            name="i-hugeicons-arrow-right-01"
            class="size-4 shrink-0 text-muted-foreground/70"
          />
        </NuxtLink>
        <ConcurrencyStepper
          v-if="agent.role !== 'pm'"
          :agent="agent"
          compact
          class="shrink-0"
        />
      </li>
    </ul>
    <p class="px-4 text-xs text-muted-foreground">
      Each runs through your local CLI login; Corral never sees your credentials.
    </p>

    <h2 class="px-4 pt-4 text-sm font-semibold text-foreground">
      Appearance
    </h2>
    <div class="flex flex-col gap-3 px-4">
      <SettingsColorMode />
      <div>
        <p class="mb-1.5 text-sm text-foreground">
          Dark background
        </p>
        <DarkNeutralPicker />
        <p class="mt-1.5 text-xs text-muted-foreground">
          Dark mode only. Saved for this device only.
        </p>
      </div>
      <div>
        <p class="mb-1.5 text-sm text-foreground">
          Layout
        </p>
        <SettingsLayoutMode />
        <p class="mt-1.5 text-xs text-muted-foreground">
          Auto uses the mobile layout on a phone or the installed app. Saved for this device only.
        </p>
      </div>
    </div>

    <!-- Only where the browser can install it, and not once installed -->
    <template v-if="install.mode.value">
      <h2 class="px-4 pt-4 text-sm font-semibold text-foreground">
        App
      </h2>
      <ul class="divide-y divide-border border-y border-border">
        <li>
          <SettingsInstallRow />
        </li>
      </ul>
    </template>
  </div>
</template>
