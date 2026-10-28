<script setup lang="ts">
import type { Project } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { initials, isWorking, projectColor, ROLE } from '~/utils/labels'

// The app shell (design/app-shell.md): global nav, projects, agents, runner
const live = useLive()
const state = live.state
const route = useRoute()
const router = useRouter()
const toast = useToast()

const expanded = useLocalStorage<Record<string, boolean>>('corral.sidebar.projects', {})
const toggle = (project: Project) => {
  expanded.value = { ...expanded.value, [project.id]: !(expanded.value[project.id] ?? true) }
}
const isExpanded = (project: Project) => expanded.value[project.id] ?? true

const currentSlug = computed(() => typeof route.params.slug === 'string' ? route.params.slug : null)
const currentProject = computed(() => state.value.projects.find(p => p.slug === currentSlug.value) ?? null)

const counts = (project: Project) => {
  const tasks = state.value.tasks[project.id] ?? []
  return { board: tasks.filter(t => t.status !== 'backlog').length, backlog: tasks.filter(t => t.status === 'backlog').length }
}
watch(() => state.value.projects, (projects) => {
  for (const project of projects) {
    if (!state.value.tasks[project.id]) void live.loadTasks(project)
  }
}, { immediate: true })

const planUnread = computed(() => state.value.planSessions.some(s => s.unread))
const runnerColor = computed(() => !state.value.runner?.online ? 'error' : state.value.connection === 'open' ? 'success' : 'warning')

async function resume(project: Project) {
  try {
    await api.projects.patch(project.slug, { paused: false })
  } catch (error) {
    toast.add({ title: 'Could not resume', description: error instanceof Error ? error.message : String(error), color: 'error' })
  }
}
async function resumeAll() {
  try {
    await api.resumeAll()
  } catch (error) {
    toast.add({ title: 'Could not resume', description: error instanceof Error ? error.message : String(error), color: 'error' })
  }
}

const searchOpen = ref(false)
const searchGroups = computed(() => [{
  id: 'pages',
  label: 'Go to',
  items: [
    { label: 'Plan', icon: 'i-lucide-message-square', to: '/plan' },
    { label: 'Inbox', icon: 'i-lucide-inbox', to: '/inbox' },
    { label: 'Settings', icon: 'i-lucide-settings', to: '/settings/profile' },
    ...state.value.projects.flatMap(p => [
      { label: `${p.name} · Overview`, icon: 'i-lucide-layout-dashboard', to: `/projects/${p.slug}` },
      { label: `${p.name} · Board`, icon: 'i-lucide-kanban', to: `/projects/${p.slug}/board` },
      { label: `${p.name} · Backlog`, icon: 'i-lucide-list', to: `/projects/${p.slug}/backlog` }
    ]),
    ...state.value.agents.map(a => ({ label: `${a.name} · ${ROLE[a.role]}`, icon: 'i-lucide-bot', to: `/agents/${a.name.toLowerCase()}` }))
  ]
}, {
  id: 'tasks',
  label: 'Tasks',
  items: Object.values(state.value.tasks).flat().map(t => ({ label: `${t.ref} ${t.title}`, icon: 'i-lucide-square-check', to: `/tasks/${t.ref}` }))
}])
function onSearchSelect(item: { to?: string }) {
  searchOpen.value = false
  if (item.to) void router.push(item.to)
}
defineShortcuts({
  meta_k: () => {
    searchOpen.value = !searchOpen.value
  }
})

const isActive = (path: string) => route.path === path || route.path.startsWith(`${path}/`)
</script>

<template>
  <div class="min-h-svh bg-default text-default">
    <UAlert
      v-if="state.status.stopped"
      color="error"
      variant="solid"
      icon="i-lucide-octagon-x"
      title="Corral is stopped. No runs will start until you resume."
      :ui="{ root: 'rounded-none' }"
      :actions="[{ label: 'Resume everything', color: 'neutral', variant: 'solid', onClick: resumeAll }]"
    />
    <UAlert
      v-else-if="currentProject?.paused"
      color="warning"
      variant="solid"
      icon="i-lucide-pause"
      :title="`${currentProject.name} is paused. No new runs will start; work already running will finish.`"
      :ui="{ root: 'rounded-none' }"
      :actions="[{ label: 'Resume', color: 'neutral', variant: 'solid', onClick: () => resume(currentProject!) }]"
    />
    <UAlert
      v-else-if="state.loaded && !state.runner?.online"
      color="warning"
      variant="subtle"
      icon="i-lucide-server-off"
      title="The runner is offline. Plan and live runs are unavailable until it reconnects."
      :ui="{ root: 'rounded-none' }"
    />
    <UAlert
      v-else-if="state.connection === 'reconnecting'"
      color="neutral"
      variant="subtle"
      icon="i-lucide-refresh-cw"
      title="Reconnecting to Corral…"
      :ui="{ root: 'rounded-none' }"
    />

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
            @click="searchOpen = true"
          />

          <nav
            aria-label="Global"
            class="flex flex-col gap-0.5"
          >
            <UButton
              to="/plan"
              icon="i-lucide-message-square"
              :label="collapsed ? undefined : 'Plan'"
              variant="ghost"
              :color="isActive('/plan') ? 'primary' : 'neutral'"
              :class="['justify-start', isActive('/plan') && 'bg-elevated']"
              :aria-current="isActive('/plan') ? 'page' : undefined"
            >
              <template #trailing>
                <span
                  v-if="planUnread"
                  class="ms-auto size-2 rounded-full bg-primary"
                  aria-label="Unread"
                />
              </template>
            </UButton>
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
                    :class="['flex-1 justify-start', currentSlug === project.slug && 'text-highlighted']"
                  >
                    <span
                      class="flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
                      :style="{ background: projectColor(project) }"
                    >{{ initials(project.name) }}</span>
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
                :class="['w-full justify-start', isActive(`/agents/${agent.name.toLowerCase()}`) && 'bg-elevated']"
              >
                <AgentAvatar
                  :name="agent.name"
                  :working="isWorking(agent)"
                  size="xs"
                />
                <span
                  v-if="!collapsed"
                  class="truncate"
                >{{ agent.name }} <span class="text-muted">· {{ ROLE[agent.role] }}</span></span>
                <span
                  v-if="!collapsed"
                  class="ms-auto text-xs text-muted"
                >{{ isWorking(agent) ? 'Working' : agent.paused ? 'Paused' : 'Idle' }}</span>
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
            <UIcon
              name="i-lucide-server"
              class="size-4 shrink-0 text-muted"
            />
            <div
              v-if="!collapsed"
              class="min-w-0 flex-1"
            >
              <div class="font-medium">
                Runner {{ state.runner?.online ? 'online' : 'offline' }}
              </div>
              <div class="truncate text-muted">
                {{ state.runner?.name ?? 'not connected' }} · Claude
              </div>
            </div>
            <span
              :class="['size-2 shrink-0 rounded-full', runnerColor === 'success' ? 'bg-success' : runnerColor === 'warning' ? 'bg-warning' : 'bg-error']"
              aria-hidden="true"
            />
          </div>
          <div :class="['flex items-center gap-2', collapsed && 'flex-col']">
            <UAvatar
              :text="initials('You')"
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
      @update:model-value="onSearchSelect"
    />
  </div>
</template>
