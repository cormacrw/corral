<script setup lang="ts">
import { projectColor } from '~/utils/labels'

defineProps<{ compact?: boolean }>()
const route = useRoute()
const state = useLive().state
const pending = usePendingPlan()
const parts = computed(() => route.path.split('/').filter(Boolean))

// A project's own pages (Board, Backlog, Pull requests, Settings) name the project above
// the page and go back to its overview
const PROJECT_PAGES: Record<string, string> = { 'board': 'Board', 'backlog': 'Backlog', 'pull-requests': 'Pull requests', 'settings': 'Settings' }
const projectPage = computed(() => {
  const [section, slug, page] = parts.value
  if (section !== 'projects' || !slug || !page || !PROJECT_PAGES[page]) return null
  const project = state.value.projects.find(p => p.slug === slug)
  return { title: PROJECT_PAGES[page], eyebrow: project?.name ?? slug, back: `/projects/${slug}`, backLabel: 'Back to the project', dot: project ? projectColor(project) : null }
})
// A Plan conversation names its project and session, goes back to a new
// session, and takes the full height: no runner status or tab bar
const planSession = computed(() => {
  const [section, id] = parts.value
  if (section !== 'plan' || !id) return null
  const session = state.value.planSessions.find(s => s.id === id) ?? pending.entries.value[id]?.session
  const project = state.value.projects.find(p => p.id === session?.projectId)
  return { title: session?.title ?? 'Plan', eyebrow: project?.name ?? '', back: '/plan', backLabel: 'Back to Plan', dot: project ? projectColor(project) : null }
})
// An Inbox item is its own screen: the task above where it sits in the
// list, a back button to the list, and the action bar at the bottom in place of
// the tab bar
const mobileHeader = useMobileHeader()
const inboxItem = computed(() => {
  const [section, id] = parts.value
  if (section !== 'inbox' || !id) return null
  return { title: mobileHeader.value?.title || 'Inbox', eyebrow: mobileHeader.value?.eyebrow ?? 'Inbox', back: '/inbox', backLabel: 'Back to Inbox', dot: null }
})
const subPage = computed(() => projectPage.value ?? planSession.value ?? inboxItem.value)
// Agent and project overview screens have their own settings action
const agentPage = computed(() => parts.value[0] === 'agents' && parts.value.length === 2)
// Settings lists its sections at /settings, and each section is its own
// screen that goes back to the list.
const SETTINGS_SECTIONS: Record<string, string> = { profile: 'Profile', agents: 'Agents', runner: 'Runners', appearance: 'Appearance' }
const settingsPage = computed(() => parts.value[0] === 'settings')
const settingsSection = computed(() => settingsPage.value ? SETTINGS_SECTIONS[parts.value[1] ?? ''] ?? null : null)
const overviewPage = computed(() => parts.value[0] === 'projects' && parts.value.length === 2)
const back = computed(() => subPage.value
  ? { to: subPage.value.back, label: subPage.value.backLabel }
  : agentPage.value
    ? { to: '/home', label: 'Back to Home' }
    : overviewPage.value
      ? { to: '/projects', label: 'Back to Projects' }
      : settingsSection.value
        ? { to: '/settings', label: 'Back to Settings' }
        : null)
const action = computed(() => agentPage.value
  ? { to: '/settings/agents', icon: 'i-lucide-sliders-horizontal', label: 'Agent settings' }
  : overviewPage.value
    ? { to: `/projects/${parts.value[1]}/settings`, icon: 'i-lucide-sliders-horizontal', label: 'Project settings' }
    : null)

// The header names the page
const title = computed(() => {
  if (subPage.value) return subPage.value.title
  const [section, id] = parts.value
  switch (section) {
    case 'home': return 'Home'
    case 'plan': return 'Plan'
    case 'inbox': return 'Inbox'
    case 'settings': return settingsSection.value ?? 'Settings'
    case 'tasks': return id ?? 'Task'
    case 'epics': return 'Epic'
    case 'projects': return id ? 'Overview' : 'Projects'
    case 'agents': {
      if (!id) return 'Agents'
      return state.value.agents.find(a => a.name.toLowerCase() === id)?.name ?? 'Agent'
    }
    default: return 'Corral'
  }
})
</script>

<template>
  <div
    data-testid="mobile-page-header"
    :class="['shrink-0 bg-default pt-[env(safe-area-inset-top)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]', compact && 'border-b border-default']"
  >
    <div :class="['flex items-center gap-2 px-4', compact ? 'min-h-14 py-2' : 'py-5']">
      <UButton
        v-if="back"
        :to="back.to"
        icon="i-lucide-arrow-left"
        variant="ghost"
        color="neutral"
        :aria-label="back.label"
        class="-ms-2"
      />
      <div class="min-w-0 flex-1">
        <p
          v-if="subPage?.eyebrow"
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
        <h1 :class="['truncate font-semibold text-highlighted', compact ? 'text-lg leading-tight' : 'text-2xl']">
          {{ title }}
        </h1>
      </div>
      <div
        class="flex shrink-0 items-center gap-1"
        data-testid="mobile-page-actions"
      >
        <slot name="actions" />
        <UButton
          v-if="action"
          :to="action.to"
          :icon="action.icon"
          variant="ghost"
          color="neutral"
          :aria-label="action.label"
        />
      </div>
    </div>
  </div>
</template>
