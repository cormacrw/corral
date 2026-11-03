<script setup lang="ts">
// The desktop section menu (design/settings.md). Phones list the sections on
// /settings instead (SettingsMobile).
const SECTIONS = [
  { label: 'Profile', to: '/settings/profile', icon: 'i-hugeicons-user' },
  { label: 'Agents', to: '/settings/agents', icon: 'i-hugeicons-robot-01' },
  { label: 'Runners', to: '/settings/runner', icon: 'i-hugeicons-server-stack-01' },
  { label: 'Performance', to: '/settings/performance', icon: 'i-hugeicons-dashboard-speed-02' },
  { label: 'Appearance', to: '/settings/appearance', icon: 'i-hugeicons-paint-board' }
]

const route = useRoute()
const install = useInstall()
// /settings shows Profile on desktop, so it counts as that section
const current = computed(() => {
  const path = route.path.replace(/\/$/, '')
  return path === '/settings' ? '/settings/profile' : path
})
const items = computed(() => SECTIONS.map(section => ({ ...section, active: current.value === section.to })))
</script>

<template>
  <aside class="w-56 shrink-0 max-[800px]:w-full">
    <h1 class="mb-2 text-lg font-semibold">
      Settings
    </h1>
    <AppNavMenu
      :items="items"
      orientation="vertical"
    />
    <p class="mt-3 text-xs text-muted-foreground">
      Settings here apply to every project. Each project has its own settings in the sidebar.
    </p>
    <!-- Only where the browser can install it, and not once installed -->
    <template v-if="install.mode.value">
      <h2 class="mt-6 mb-2 text-xs font-semibold text-muted-foreground">
        App
      </h2>
      <SettingsInstallRow dense />
    </template>
  </aside>
</template>
