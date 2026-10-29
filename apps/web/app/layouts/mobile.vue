<script setup lang="ts">
// The mobile shell (D17, design/mobile.md): banners, the page and a five-tab
// bar. app.vue swaps it in for the default layout; URLs stay the same.
const live = useLive()
const state = live.state
const route = useRoute()

// Pages read tasks from live state, as they do under the web shell
watch(() => state.value.projects, (projects) => {
  for (const project of projects) {
    if (!state.value.tasks[project.id]) void live.loadTasks(project)
  }
}, { immediate: true })

const planUnread = computed(() => state.value.planSessions.some(s => s.unread))

const isActive = (...paths: string[]) => paths.some(path => route.path === path || route.path.startsWith(`${path}/`))

const tabs = computed(() => [
  { label: 'Home', icon: 'i-lucide-layout-grid', to: '/home', active: isActive('/home') || route.path === '/' },
  { label: 'Plan', icon: 'i-lucide-message-square', to: '/plan', active: isActive('/plan'), dot: planUnread.value },
  { label: 'Inbox', icon: 'i-lucide-inbox', to: '/inbox', active: isActive('/inbox'), badge: state.value.inboxCount },
  // Tasks and epics belong to a project
  { label: 'Projects', icon: 'i-lucide-folder', to: '/projects', active: isActive('/projects', '/tasks', '/epics') },
  { label: 'Settings', icon: 'i-lucide-settings', to: '/settings', active: isActive('/settings') }
])

const parts = computed(() => route.path.split('/').filter(Boolean))
const fullScreen = computed(() => parts.value[0] === 'agents' && parts.value.length >= 3)
const ownHeader = computed(() => isActive('/tasks', '/epics'))
const focused = computed(() => ['plan', 'inbox'].includes(parts.value[0] ?? '') && parts.value.length >= 2)
</script>

<template>
  <div class="flex h-svh flex-col bg-default text-default">
    <div
      v-if="ownHeader"
      class="shrink-0 pt-[env(safe-area-inset-top)]"
    />

    <div class="shrink-0 has-[*]:pt-[env(safe-area-inset-top)]">
      <ShellBanners />
    </div>

    <!-- Panels with default-slot content scroll above the tab bar, including
         their in-page title. Focused screens scroll only their inner body,
         leaving the compact title row and composer in place. -->
    <UDashboardGroup
      class="relative inset-auto min-h-0 flex-1 overflow-x-auto overscroll-contain *:min-h-0 *:overflow-y-auto *:overscroll-contain"
      storage-key="mobile-dashboard"
    >
      <slot />
    </UDashboardGroup>

    <nav
      v-if="!fullScreen && !focused && !isActive('/tasks')"
      aria-label="Main"
      class="shrink-0 border-t border-default bg-default pb-[env(safe-area-inset-bottom)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]"
    >
      <ul class="grid grid-cols-5">
        <li
          v-for="tab in tabs"
          :key="tab.to"
        >
          <NuxtLink
            :to="tab.to"
            :class="['flex h-14 flex-col items-center justify-center gap-0.5 text-xs', tab.active ? 'font-medium text-primary' : 'text-muted']"
            :aria-current="tab.active ? 'page' : undefined"
          >
            <span class="relative">
              <UIcon
                :name="tab.icon"
                class="size-6"
              />
              <span
                v-if="tab.badge"
                class="absolute -end-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-inverted"
                :aria-label="`${tab.badge} open`"
                data-testid="inbox-count"
              >{{ tab.badge }}</span>
              <span
                v-else-if="tab.dot"
                class="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-primary"
                aria-label="Unread"
              />
            </span>
            {{ tab.label }}
          </NuxtLink>
        </li>
      </ul>
    </nav>
  </div>
</template>
