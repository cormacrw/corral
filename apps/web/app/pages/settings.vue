<script setup lang="ts">
const route = useRoute()
const device = useDevice()
const install = useInstall()
// List, Agents and Runners have edge-to-edge phone layouts.
const fullBleed = computed(() => device.isMobile.value && ['/settings', '/settings/agents', '/settings/runner'].includes(route.path.replace(/\/$/, '')))
useSeoMeta({ title: 'Settings · Corral' })
const items = [
  { label: 'Profile', to: '/settings/profile', icon: 'i-lucide-user' },
  { label: 'Agents', to: '/settings/agents', icon: 'i-lucide-bot' },
  { label: 'Runners', to: '/settings/runner', icon: 'i-lucide-server' },
  { label: 'Appearance', to: '/settings/appearance', icon: 'i-lucide-palette' }
]
</script>

<template>
  <UDashboardPanel>
    <MobilePageHeader v-if="device.isMobile.value && !fullBleed" />
    <div :class="fullBleed ? '' : ['mx-auto flex w-full max-w-[1100px] gap-8 max-[800px]:flex-col', device.isMobile.value ? 'p-4' : 'p-6']">
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

      <div :class="fullBleed ? '' : 'flex min-w-0 max-w-[880px] flex-1 flex-col gap-6'">
        <NuxtPage />
      </div>
    </div>
  </UDashboardPanel>
</template>
