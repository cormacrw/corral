<script setup lang="ts">
import { projectColor, ROLE } from '~/utils/labels'

// The mobile shell (D17, design/mobile.md): a header with the runner's
// status, the page, and a five-tab bar. app.vue swaps it in for the
// default layout on mobile; the URLs are the same as on the web.
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
const runnerColor = computed(() => !state.value.runner?.online ? 'error' : state.value.connection === 'open' ? 'success' : 'warning')

const isActive = (...paths: string[]) => paths.some(path => route.path === path || route.path.startsWith(`${path}/`))

const tabs = computed(() => [
  { label: 'Home', icon: 'i-lucide-layout-grid', to: '/home', active: isActive('/home') || route.path === '/' },
  { label: 'Plan', icon: 'i-lucide-message-square', to: '/plan', active: isActive('/plan'), dot: planUnread.value },
  { label: 'Inbox', icon: 'i-lucide-inbox', to: '/inbox', active: isActive('/inbox'), badge: state.value.inboxCount },
  // Tasks and epics belong to a project
  { label: 'Projects', icon: 'i-lucide-folder', to: '/projects', active: isActive('/projects', '/tasks', '/epics') },
  { label: 'Agents', icon: 'i-lucide-bot', to: '/agents', active: isActive('/agents') }
])

// A project's own pages (Board, Backlog, Settings) name the project above
// the page and go back to its overview
const PROJECT_PAGES: Record<string, string> = { board: 'Board', backlog: 'Backlog', settings: 'Settings' }
const projectPage = computed(() => {
  const [section, slug, page] = route.path.split('/').filter(Boolean)
  if (section !== 'projects' || !slug || !page || !PROJECT_PAGES[page]) return null
  const project = state.value.projects.find(p => p.slug === slug)
  return { title: PROJECT_PAGES[page], eyebrow: project?.name ?? slug, back: `/projects/${slug}`, backLabel: 'Back to the project', dot: null }
})
// A Plan conversation names its project and session, goes back to a new
// session, and takes the full height: no runner status, Settings or tab bar
const planSession = computed(() => {
  const [section, id] = route.path.split('/').filter(Boolean)
  if (section !== 'plan' || !id) return null
  const session = state.value.planSessions.find(s => s.id === id)
  const project = state.value.projects.find(p => p.id === session?.projectId)
  return { title: session?.title ?? 'Plan', eyebrow: project?.name ?? '', back: '/plan', backLabel: 'Back to Plan', dot: project ? projectColor(project) : null }
})
const subPage = computed(() => projectPage.value ?? planSession.value)

// The header names the page; later tasks give each screen its own header
const title = computed(() => {
  if (subPage.value) return subPage.value.title
  const [section, id] = route.path.split('/').filter(Boolean)
  switch (section) {
    case 'home': return 'Home'
    case 'plan': return 'Plan'
    case 'inbox': return 'Inbox'
    case 'settings': return 'Settings'
    case 'tasks': return id ?? 'Task'
    case 'epics': return 'Epic'
    case 'projects': return state.value.projects.find(p => p.slug === id)?.name ?? 'Projects'
    case 'agents': {
      const agent = state.value.agents.find(a => a.name.toLowerCase() === id)
      return agent ? `${agent.name} · ${ROLE[agent.role]}` : 'Agents'
    }
    default: return 'Corral'
  }
})
</script>

<template>
  <div class="flex h-svh flex-col bg-default text-default">
    <header class="shrink-0 border-b border-default bg-default pt-[env(safe-area-inset-top)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]">
      <div class="flex h-14 items-center gap-2 px-4">
        <UButton
          v-if="subPage"
          :to="subPage.back"
          icon="i-lucide-arrow-left"
          variant="ghost"
          color="neutral"
          :aria-label="subPage.backLabel"
          class="-ms-2"
        />
        <div class="min-w-0 flex-1">
          <p
            v-if="subPage"
            class="flex items-center gap-1.5 truncate text-xs text-muted"
          >
            <span
              v-if="subPage.dot"
              class="size-2 shrink-0 rounded-full"
              :style="{ background: subPage.dot }"
              aria-hidden="true"
            />
            {{ subPage.eyebrow }}
          </p>
          <h1 :class="['truncate font-semibold text-highlighted', subPage ? 'text-lg leading-tight' : 'text-xl']">
            {{ title }}
          </h1>
        </div>
        <span
          v-if="!planSession"
          class="flex shrink-0 items-center gap-1.5 text-xs text-muted"
          data-testid="runner-status"
        >
          <span
            :class="['size-2 rounded-full', runnerColor === 'success' ? 'bg-success' : runnerColor === 'warning' ? 'bg-warning' : 'bg-error']"
            aria-hidden="true"
          />
          Runner {{ state.runner?.online ? 'online' : 'offline' }}
        </span>
        <!-- Pages put their own header actions here (search, New task) -->
        <div
          id="mobile-header-actions"
          class="contents"
        />
        <UButton
          v-if="!planSession"
          to="/settings/profile"
          icon="i-lucide-settings"
          variant="ghost"
          color="neutral"
          aria-label="Settings"
        />
      </div>
    </header>

    <ShellBanners />

    <!-- Pages without a mobile screen yet reflow in here as well as they can -->
    <UDashboardGroup
      class="relative inset-auto min-h-0 flex-1 overflow-x-auto *:min-h-0"
      storage-key="mobile-dashboard"
    >
      <slot />
    </UDashboardGroup>

    <nav
      v-if="!planSession"
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
