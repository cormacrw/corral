<script setup lang="ts">
import AppBadge from '~/components/app/AppBadge.vue'
// The mobile shell (D17, design/mobile.md): banners, the page and a five-tab
// bar. app.vue swaps it in for the default layout; URLs stay the same.
import { stepsToAppStart } from '~/utils/app-history'

const shell = useShell()
// Keep the same shared list queries warm as the desktop shell
useAllProjectLists(() => shell.projects)
const route = useRoute()
const router = useRouter()

let pendingTab = ''
let resettingHistory = false

async function selectTab(event: MouseEvent, to: string) {
  // Keep normal link behaviour for opening a tab in another browser tab.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  pendingTab = to
  if (resettingHistory) return
  resettingHistory = true
  try {
    // Back to Corral's own first entry, not the browser tab's: earlier
    // entries may be other sites.
    const steps = stepsToAppStart(window.history.state?.position)
    if (steps > 0) {
      await new Promise<void>((resolve) => {
        window.addEventListener('popstate', () => resolve(), { once: true })
        // Suppress the router's pop navigation: intermediate pages must not
        // render (or unmount this shell) while returning to the first entry.
        router.options.history.go(-steps, false)
      })
    }
    // Rapid taps during the asynchronous traversal use the latest destination.
    // The router still thinks it is on the page we left, so force the replace:
    // when that page is the same tab root, it would otherwise be skipped as a
    // duplicate and leave the first entry's URL in the address bar.
    let destination: string
    do {
      destination = pendingTab
      await router.replace({ path: destination, force: steps > 0 })
    } while (pendingTab !== destination)
  } finally {
    resettingHistory = false
  }
}

const planUnread = computed(() => shell.planSessions.some(s => s.unread))

const isActive = (...paths: string[]) => paths.some(path => route.path === path || route.path.startsWith(`${path}/`))

const tabs = computed(() => [
  { label: 'Home', icon: 'i-hugeicons-dashboard-square-02', to: '/home', active: isActive('/home') || route.path === '/' },
  { label: 'Plan', icon: 'i-hugeicons-message-01', to: '/plan', active: isActive('/plan'), dot: planUnread.value },
  { label: 'Inbox', icon: 'i-hugeicons-inbox', to: '/inbox', active: isActive('/inbox'), badge: shell.inboxCount },
  // Tasks and epics belong to a project
  { label: 'Projects', icon: 'i-hugeicons-folder-01', to: '/projects', active: isActive('/projects', '/tasks', '/epics') },
  { label: 'Settings', icon: 'i-hugeicons-settings-01', to: '/settings', active: isActive('/settings') }
])

const tabRoot = computed(() => ['/home', '/plan', '/inbox', '/projects', '/settings'].includes(route.path))
const parts = computed(() => route.path.split('/').filter(Boolean))
const fullScreen = computed(() => parts.value[0] === 'agents' && parts.value.length >= 3)
const ownHeader = computed(() => isActive('/tasks', '/epics'))
const focused = computed(() => ['plan', 'inbox'].includes(parts.value[0] ?? '') && parts.value.length >= 2)
</script>

<template>
  <div class="flex h-svh flex-col bg-background text-foreground [--shell-top:env(safe-area-inset-top)] has-[[data-shell-banners]>*]:[--shell-top:0px]">
    <!-- The top inset applies once: above a banner when one shows, otherwise
         through --shell-top on whatever starts the page -->
    <div
      v-if="ownHeader"
      class="shrink-0 pt-(--shell-top)"
    />

    <div
      class="shrink-0 has-[*]:pt-[env(safe-area-inset-top)]"
      data-shell-banners
    >
      <ShellBanners />
    </div>

    <!-- Panels with default-slot content scroll above the tab bar, including
         sub-page headers. Focused screens scroll only their inner body,
         leaving the compact title row and composer in place. A flex row, so
         each page is exactly the body's height: as a block, a page grows to
         its content and the whole body scrolls, taking a page's footer (such
         as the Inbox action bar) off the bottom of the screen. -->
    <div
      class="relative inset-auto flex min-h-0 flex-1 overflow-x-auto overscroll-contain *:min-h-0 *:overflow-y-auto *:overscroll-contain"
      :class="tabRoot && 'pt-(--shell-top)'"
      data-testid="mobile-body"
    >
      <slot />
    </div>

    <nav
      v-if="!fullScreen && !focused && !isActive('/tasks')"
      aria-label="Main"
      class="shrink-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]"
    >
      <ul class="grid grid-cols-5">
        <li
          v-for="tab in tabs"
          :key="tab.to"
        >
          <NuxtLink
            v-slot="{ href }"
            :to="tab.to"
            custom
          >
            <a
              :href="href ?? undefined"
              :class="['flex h-14 flex-col items-center justify-center gap-0.5 text-xs', tab.active ? 'font-medium text-brand' : 'text-muted-foreground']"
              :aria-current="tab.active ? 'page' : undefined"
              @click="selectTab($event, tab.to)"
            >
              <span class="relative">
                <Icon
                  :name="tab.icon"
                  class="size-6"
                />
                <AppBadge
                  v-if="tab.badge"
                  :label="tab.badge"
                  size="xs"
                  class="absolute -end-2.5 -top-1.5 min-w-4 tabular-nums"
                  :aria-label="`${tab.badge} open`"
                  data-testid="inbox-count"
                />
                <span
                  v-else-if="tab.dot"
                  class="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-primary"
                  aria-label="Unread"
                />
              </span>
              {{ tab.label }}
            </a>
          </NuxtLink>
        </li>
      </ul>
    </nav>
  </div>
</template>
