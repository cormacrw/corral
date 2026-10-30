<script setup lang="ts">
import type { Project } from '@corral/contracts'
import { agentStatus, isWorking, projectColor, ROLE, runnerSummary, taskCounts } from '~/utils/labels'
import { searchPages } from '~/utils/search'

// The app shell (design/app-shell.md): global nav, projects, agents, runner
const live = useLive()
const state = live.state
const route = useRoute()
const now = ref(Date.now())
onMounted(() => {
  const timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  onBeforeUnmount(() => clearInterval(timer))
})

const expanded = useLocalStorage<Record<string, boolean>>('corral.sidebar.projects', {})
const toggle = (project: Project) => {
  expanded.value = { ...expanded.value, [project.id]: !(expanded.value[project.id] ?? true) }
}
const isExpanded = (project: Project) => expanded.value[project.id] ?? true

const currentSlug = computed(() => typeof route.params.slug === 'string' ? route.params.slug : null)

const counts = (project: Project) => taskCounts(state.value.tasks[project.id] ?? [])
watch(() => state.value.projects, (projects) => {
  for (const project of projects) {
    if (!state.value.tasks[project.id]) void live.loadTasks(project)
  }
}, { immediate: true })

const { active, sessions: threads, close: closeThread } = useOpenPlanSessions()
const attention = (session: typeof threads.value[number]) => session.status === 'needs_approval' ? 'Needs approval' : session.status === 'question' ? 'Question' : session.unread ? 'Unread reply' : null
const attentionCount = computed(() => threads.value.filter(s => attention(s)).length)
const threadColor = (projectId: string) => {
  const project = state.value.projects.find(p => p.id === projectId)
  return project ? projectColor(project) : undefined
}
const runnerColor = computed(() => !state.value.runner?.online ? 'error' : state.value.connection === 'open' ? 'success' : 'warning')

// UDashboardSearch owns the palette's behaviour: it binds ⌘K/Ctrl+K, opens on the
// Search… button (via the dashboard toggle hook) and closes once an item is picked.
// Items navigate through their `to`. Don't add handlers for any of these here, or
// one action runs twice and the palette flashes open and shut.
const searchOpen = ref(false)
const searchGroups = computed(() => [{
  id: 'pages',
  label: 'Go to',
  items: searchPages(state.value.projects, state.value.agents)
}, {
  id: 'tasks',
  label: 'Tasks',
  items: Object.values(state.value.tasks).flat().map(t => ({ label: `${t.ref} ${t.title}`, icon: 'i-lucide-square-check', to: `/tasks/${t.ref}` }))
}])

const isActive = (path: string) => route.path === path || route.path.startsWith(`${path}/`)
</script>

<template>
  <div class="flex h-svh flex-col bg-default text-default">
    <ShellBanners />

    <UDashboardGroup>
      <UDashboardSidebar
        collapsible
        :ui="{ footer: 'flex-col items-stretch gap-2 border-t border-default', body: 'gap-3' }"
      >
        <template #header="{ collapsed }">
          <NuxtLink
            to="/"
            class="flex items-center gap-2 font-semibold"
          >
            <span class="flex size-7 items-center justify-center rounded-md bg-primary text-inverted">
              <UIcon
                name="i-lucide-fence"
                class="size-4"
              />
            </span>
            <span v-if="!collapsed">Corral</span>
          </NuxtLink>
        </template>

        <template #default="{ collapsed }">
          <UDashboardSearchButton
            :collapsed="collapsed"
            label="Search…"
          />

          <nav
            aria-label="Global"
            class="flex flex-col gap-0.5"
          >
            <UButton
              to="/home"
              icon="i-lucide-house"
              :label="collapsed ? undefined : 'Home'"
              variant="ghost"
              :color="isActive('/home') ? 'primary' : 'neutral'"
              :class="['justify-start', isActive('/home') && 'bg-elevated']"
              :aria-current="isActive('/home') ? 'page' : undefined"
            />
            <UButton
              to="/plan"
              icon="i-lucide-message-square"
              :label="collapsed ? undefined : 'Plan'"
              variant="ghost"
              :color="isActive('/plan') ? 'primary' : 'neutral'"
              :class="['relative justify-start', isActive('/plan') && 'bg-elevated']"
              :aria-current="isActive('/plan') ? 'page' : undefined"
            >
              <template #trailing>
                <UBadge
                  v-if="attentionCount"
                  :class="collapsed ? 'absolute -end-1 -top-1 px-1 text-[10px]' : 'ms-auto'"
                  :aria-label="`${attentionCount} threads need attention`"
                  :label="String(attentionCount)"
                  size="sm"
                />
              </template>
            </UButton>
            <div
              v-if="!collapsed && threads.length"
              aria-label="Open Plan threads"
              class="ms-4 flex max-h-64 flex-col gap-0.5 overflow-y-auto overscroll-contain border-s border-default ps-2"
            >
              <div
                v-for="thread in threads"
                :key="thread.id"
                :class="['group flex min-w-0 items-center rounded-md', active === thread.id && 'bg-elevated text-primary']"
                data-testid="plan-thread"
              >
                <NuxtLink
                  :to="`/plan/${thread.id}`"
                  :title="thread.title"
                  :aria-current="active === thread.id ? 'page' : undefined"
                  class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm hover:bg-elevated"
                >
                  <span
                    class="size-2 shrink-0 rounded-full bg-muted"
                    :style="{ background: threadColor(thread.projectId) }"
                    aria-hidden="true"
                  />
                  <span :class="['min-w-0 flex-1 truncate', attention(thread) && 'font-semibold text-highlighted']">{{ thread.title }}</span>
                  <UIcon
                    v-if="thread.activeRunId"
                    name="i-lucide-loader-circle"
                    class="size-3.5 shrink-0 animate-spin text-muted"
                    aria-label="Juno is working"
                  />
                  <UTooltip
                    v-else-if="attention(thread)"
                    :text="attention(thread)!"
                  >
                    <span
                      :aria-label="attention(thread)!"
                      :class="['size-2 shrink-0 rounded-full', thread.status === 'needs_approval' ? 'bg-primary' : thread.status === 'question' ? 'bg-info' : 'bg-inverted']"
                    />
                  </UTooltip>
                </NuxtLink>
                <PlanCloseThread
                  :session="thread"
                  menu
                />
                <UButton
                  icon="i-lucide-x"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  :aria-label="`Close ${thread.title}`"
                  class="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                  @click="closeThread(thread)"
                />
              </div>
            </div>
            <UButton
              to="/inbox"
              icon="i-lucide-inbox"
              :label="collapsed ? undefined : 'Inbox'"
              variant="ghost"
              :color="isActive('/inbox') ? 'primary' : 'neutral'"
              :class="['justify-start', isActive('/inbox') && 'bg-elevated']"
              :aria-current="isActive('/inbox') ? 'page' : undefined"
            >
              <template #trailing>
                <UBadge
                  v-if="state.inboxCount > 0"
                  :label="String(state.inboxCount)"
                  color="primary"
                  size="sm"
                  class="ms-auto"
                />
              </template>
            </UButton>
          </nav>

          <div class="flex flex-col gap-0.5">
            <div
              v-if="!collapsed"
              class="flex items-center justify-between px-2 text-xs font-medium text-muted"
            >
              <span>Projects</span>
              <UButton
                to="/setup?step=repo&add=1"
                icon="i-lucide-plus"
                size="xs"
                variant="ghost"
                color="neutral"
                aria-label="Add project"
              />
            </div>
            <div
              v-for="project in state.projects"
              :key="project.id"
              role="group"
              :aria-label="project.name"
            >
              <div class="flex items-center">
                <UTooltip
                  :text="project.name"
                  :disabled="!collapsed"
                >
                  <UButton
                    :to="`/projects/${project.slug}`"
                    variant="ghost"
                    color="neutral"
                    :class="[collapsed ? 'p-1.5' : 'flex-1 justify-start', currentSlug === project.slug && 'text-highlighted']"
                  >
                    <ProjectThumbnail
                      :project="project"
                      :size="20"
                    />
                    <span
                      v-if="!collapsed"
                      class="truncate"
                    >{{ project.name }}</span>
                    <span
                      v-if="!collapsed && project.paused"
                      class="ms-1 text-xs text-warning"
                    >Paused</span>
                  </UButton>
                </UTooltip>
                <UButton
                  v-if="!collapsed"
                  :icon="isExpanded(project) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  :aria-expanded="isExpanded(project)"
                  :aria-label="`${isExpanded(project) ? 'Collapse' : 'Expand'} ${project.name}`"
                  @click="toggle(project)"
                />
              </div>
              <div
                v-if="!collapsed && isExpanded(project)"
                class="ms-4 flex flex-col gap-0.5 border-s border-default ps-2"
              >
                <UButton
                  :to="`/projects/${project.slug}/board`"
                  variant="ghost"
                  size="sm"
                  :color="isActive(`/projects/${project.slug}/board`) ? 'primary' : 'neutral'"
                  :class="['justify-start', isActive(`/projects/${project.slug}/board`) && 'bg-elevated']"
                >
                  Board <span class="ms-auto text-xs text-muted">{{ counts(project).board }}</span>
                </UButton>
                <UButton
                  :to="`/projects/${project.slug}/backlog`"
                  variant="ghost"
                  size="sm"
                  :color="isActive(`/projects/${project.slug}/backlog`) ? 'primary' : 'neutral'"
                  :class="['justify-start', isActive(`/projects/${project.slug}/backlog`) && 'bg-elevated']"
                >
                  Backlog <span class="ms-auto text-xs text-muted">{{ counts(project).backlog }}</span>
                </UButton>
                <UButton
                  :to="`/projects/${project.slug}/pull-requests`"
                  variant="ghost"
                  size="sm"
                  :color="isActive(`/projects/${project.slug}/pull-requests`) ? 'primary' : 'neutral'"
                  :class="['justify-start', isActive(`/projects/${project.slug}/pull-requests`) && 'bg-elevated']"
                >
                  Pull requests
                </UButton>
                <UButton
                  :to="`/projects/${project.slug}/settings`"
                  variant="ghost"
                  size="sm"
                  :color="isActive(`/projects/${project.slug}/settings`) ? 'primary' : 'neutral'"
                  :class="['justify-start', isActive(`/projects/${project.slug}/settings`) && 'bg-elevated']"
                >
                  Settings
                </UButton>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-0.5">
            <div
              v-if="!collapsed"
              class="px-2 text-xs font-medium text-muted"
            >
              Agents
            </div>
            <UTooltip
              v-for="agent in state.agents"
              :key="agent.id"
              :text="`${agent.name} · ${ROLE[agent.role]}`"
              :disabled="!collapsed"
            >
              <UButton
                :to="`/agents/${agent.name.toLowerCase()}`"
                variant="ghost"
                :color="isActive(`/agents/${agent.name.toLowerCase()}`) ? 'primary' : 'neutral'"
                :class="[collapsed ? 'p-1.5' : 'w-full justify-start', isActive(`/agents/${agent.name.toLowerCase()}`) && 'bg-elevated']"
              >
                <!-- Nav icon size, so rows stay one height and fit when collapsed -->
                <AgentAvatar
                  :name="agent.name"
                  :working="isWorking(agent)"
                  size="2xs"
                />
                <span
                  v-if="!collapsed"
                  class="truncate"
                >{{ agent.name }} <span class="text-muted">· {{ ROLE[agent.role] }}</span></span>
                <span
                  v-if="!collapsed && agentStatus(agent, now)"
                  class="ms-auto text-xs text-muted"
                >{{ agentStatus(agent, now)?.label }}</span>
              </UButton>
            </UTooltip>
          </div>

          <div class="mt-auto">
            <UButton
              to="/settings/profile"
              icon="i-lucide-settings"
              :label="collapsed ? undefined : 'Settings'"
              variant="ghost"
              :color="isActive('/settings') ? 'primary' : 'neutral'"
              :class="['w-full justify-start', isActive('/settings') && 'bg-elevated']"
            />
          </div>
        </template>

        <template #footer="{ collapsed }">
          <div :class="['flex items-center gap-2 rounded-md bg-elevated p-2 text-xs', collapsed && 'justify-center']">
            <span class="relative inline-flex shrink-0">
              <UIcon
                name="i-lucide-server"
                class="size-4 text-muted"
              />
              <span
                :class="['absolute -end-0.5 -top-0.5 size-2 rounded-full ring-2 ring-(--ui-bg-elevated)', runnerColor === 'success' ? 'bg-success' : runnerColor === 'warning' ? 'bg-warning' : 'bg-error']"
                aria-hidden="true"
              />
            </span>
            <div
              v-if="!collapsed"
              class="min-w-0 flex-1"
            >
              <div class="font-medium">
                Runner {{ state.runner?.online ? 'online' : 'offline' }}
              </div>
              <div class="truncate text-muted">
                {{ runnerSummary(state.runner) }}
              </div>
            </div>
          </div>
          <div :class="['flex items-center gap-2', collapsed && 'flex-col']">
            <AgentAvatar
              name="You"
              size="sm"
            />
            <span
              v-if="!collapsed"
              class="flex-1 truncate text-sm"
            >You</span>
            <UColorModeButton />
            <UDashboardSidebarCollapse />
          </div>
        </template>
      </UDashboardSidebar>

      <slot />
    </UDashboardGroup>

    <UDashboardSearch
      v-model:open="searchOpen"
      :groups="searchGroups"
      placeholder="Search pages and tasks…"
    />
  </div>
</template>
