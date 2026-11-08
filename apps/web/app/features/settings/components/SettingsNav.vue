<script setup lang="ts">
import { SECTIONS, SETTINGS_SECTIONS, settingsPath } from '~/utils/routes'

// The desktop section menu (design/settings.md). Phones list the sections on
// /settings instead (SettingsMobile).

const route = useRoute()
const install = useInstall()
// /settings shows Profile on desktop, so it counts as that section
const current = computed(() => {
  const path = route.path.replace(/\/$/, '')
  return path === SECTIONS.settings.to ? settingsPath('profile') : path
})
const items = computed(() => SETTINGS_SECTIONS.map(({ section, label, icon }) => ({ label, icon, to: settingsPath(section), active: current.value === settingsPath(section) })))
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
