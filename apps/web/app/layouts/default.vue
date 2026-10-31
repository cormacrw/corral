<script setup lang="ts">
import type { Project } from '@corral/contracts'
import { agentStatus, isWorking, projectColor, ROLE, runnerSummary, taskCounts } from '~/utils/labels'
import { searchPages } from '~/utils/search'
import { shellTitle } from '~/utils/shell'

// The app shell (design/app-shell.md): global nav, projects, agents, runner
const shell = useShell()
const { connection } = useLive()
const lists = useAllProjectLists(() => shell.projects)
const route = useRoute()
// An agent's status only changes with time when a usage-limit wait runs out,
// so this wakes for that and nothing else. setTimeout can't wait past 2^31 ms.
const now = ref(Date.now())
let usageWait: ReturnType<typeof setTimeout> | undefined
function watchUsageWaits() {
  clearTimeout(usageWait)
  now.value = Date.now()
  const waits = shell.agents.map(a => a.pausedUntil ? new Date(a.pausedUntil).getTime() - now.value : 0).filter(ms => ms > 0)
  if (waits.length) usageWait = setTimeout(watchUsageWaits, Math.min(...waits, 2 ** 31 - 1))
}
watch(() => shell.agents, watchUsageWaits, { immediate: true })
onBeforeUnmount(() => clearTimeout(usageWait))

const expanded = useLocalStorage<Record<string, boolean>>('corral.sidebar.projects', {})
const toggle = (project: Project) => {
  expanded.value = { ...expanded.value, [project.id]: !(expanded.value[project.id] ?? true) }
}
const isExpanded = (project: Project) => expanded.value[project.id] ?? true

const currentSlug = computed(() => typeof route.params.slug === 'string' ? route.params.slug : null)
// The one docked flyout for pages that set the taskFlyout meta, kept here so it
// lives through navigation. Inbox and Plan host their own: theirs fills its plan
// slot from page state, and the Inbox swaps it with the selected item.
const missing = useProjectMissing(currentSlug)
const flyoutHosted = computed(() => Boolean(route.meta.taskFlyout) && !missing.value)

const counts = computed(() => new Map(shell.projects.map(p => [p.id, taskCounts(lists.tasks.value[p.id] ?? [])])))

const { active, sessions: threads, close: closeThread } = useOpenPlanSessions()
const attention = (session: typeof threads.value[number]) => session.status === 'needs_approval' ? 'Needs approval' : session.status === 'question' ? 'Question' : session.unread ? 'Unread reply' : null
const attentionCount = computed(() => threads.value.filter(s => attention(s)).length)
const threadColor = (projectId: string) => {
  const project = shell.projects.find(p => p.id === projectId)
  return project ? projectColor(project) : undefined
}
const runnerColor = computed(() => !shell.runner?.online ? 'error' : connection.value === 'open' ? 'success' : 'warning')

// UDashboardSearch owns the palette's behaviour: it binds ⌘K/Ctrl+K, opens on the
// Search… button (via the dashboard toggle hook) and closes once an item is picked.
// Items navigate through their `to`. Don't add handlers for any of these here, or
// one action runs twice and the palette flashes open and shut.
const searchOpen = ref(false)
// Built while open only: every task event would otherwise flatten every task.
const searchGroups = computed(() => searchOpen.value
  ? [{
      id: 'pages',
      label: 'Go to',
      items: searchPages(shell.projects, shell.agents)
    }, {
      id: 'tasks',
      label: 'Tasks',
      items: Object.values(lists.tasks.value).flatMap(tasks => tasks ?? []).map(t => ({ label: `${t.ref} ${t.title}`, icon: 'i-lucide-square-check', to: `/tasks/${t.ref}` }))
    }]
  : [])

const isActive = (path: string) => route.path === path || route.path.startsWith(`${path}/`)
// Below 1024px the sidebar is an overlay, and this bar names the page (design/app-shell.md)
const title = computed(() => shellTitle(route.path, shell.projects, shell.agents))
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
            <UTooltip
              text="Plan"
              :disabled="!collapsed"
            >
              <UButton
                to="/plan"
                icon="i-lucide-message-square"
                :label="collapsed ? undefined : 'Plan'"
                :aria-label="collapsed ? 'Plan' : undefined"
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
            </UTooltip>
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
            <UTooltip
              text="Inbox"
              :disabled="!collapsed"
            >
              <UButton
                to="/inbox"
                icon="i-lucide-inbox"
                :label="collapsed ? undefined : 'Inbox'"
                :aria-label="collapsed ? 'Inbox' : undefined"
                variant="ghost"
                :color="isActive('/inbox') ? 'primary' : 'neutral'"
                :class="['relative justify-start', isActive('/inbox') && 'bg-elevated']"
                :aria-current="isActive('/inbox') ? 'page' : undefined"
              >
                <template #trailing>
                  <UBadge
                    v-if="shell.inboxCount > 0"
                    :class="collapsed ? 'absolute -end-1 -top-1 px-1 text-[10px]' : 'ms-auto'"
                    :label="String(shell.inboxCount)"
                    color="primary"
                    size="sm"
                  />
                </template>
              </UButton>
            </UTooltip>
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
              v-for="project in shell.projects"
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
                    :aria-label="collapsed ? project.name : undefined"
                    variant="ghost"
                    color="neutral"
                    :class="[collapsed ? 'p-1.5' : 'min-w-0 flex-1 justify-start', currentSlug === project.slug && 'text-highlighted']"
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
                      class="ms-1 shrink-0 text-xs text-warning"
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
                  Board <span class="ms-auto text-xs text-muted">{{ counts.get(project.id)?.board }}</span>
                </UButton>
                <UButton
                  :to="`/projects/${project.slug}/backlog`"
                  variant="ghost"
                  size="sm"
                  :color="isActive(`/projects/${project.slug}/backlog`) ? 'primary' : 'neutral'"
                  :class="['justify-start', isActive(`/projects/${project.slug}/backlog`) && 'bg-elevated']"
                >
                  Backlog <span class="ms-auto text-xs text-muted">{{ counts.get(project.id)?.backlog }}</span>
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
              v-for="agent in shell.agents"
              :key="agent.id"
              :text="`${agent.name} · ${ROLE[agent.role]}`"
              :disabled="!collapsed"
            >
              <UButton
                :to="`/agents/${agent.name.toLowerCase()}`"
                :aria-label="collapsed ? `${agent.name} · ${ROLE[agent.role]}` : undefined"
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
                  class="min-w-0 truncate"
                >{{ agent.name }} <span class="text-muted">· {{ ROLE[agent.role] }}</span></span>
                <span
                  v-if="!collapsed && agentStatus(agent, now)"
                  class="ms-auto min-w-0 truncate text-xs text-muted"
                  :title="agentStatus(agent, now)?.label"
                >{{ agentStatus(agent, now)?.label }}</span>
              </UButton>
            </UTooltip>
          </div>

          <div class="mt-auto">
            <UTooltip
              text="Settings"
              :disabled="!collapsed"
            >
              <UButton
                to="/settings/profile"
                icon="i-lucide-settings"
                :label="collapsed ? undefined : 'Settings'"
                :aria-label="collapsed ? 'Settings' : undefined"
                variant="ghost"
                :color="isActive('/settings') ? 'primary' : 'neutral'"
                :class="['w-full justify-start', isActive('/settings') && 'bg-elevated']"
              />
            </UTooltip>
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
                Runner {{ shell.runner?.online ? 'online' : 'offline' }}
              </div>
              <div class="truncate text-muted">
                {{ runnerSummary(shell.runner) }}
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

      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <UDashboardNavbar
          :title="title"
          :ui="{ root: 'h-12 lg:hidden' }"
          data-testid="shell-bar"
        />
        <!-- Panels whose content is in the default slot have no scroller of
             their own, so the panel is it. The glow around active runs stays
             clipped sideways. -->
        <div
          class="flex min-h-0 flex-1 max-[1100px]:flex-col [&>[data-slot=root]]:overflow-x-hidden [&>[data-slot=root]]:overflow-y-auto [&>[data-slot=root]]:overscroll-contain"
          data-testid="shell-page"
        >
          <slot />
          <TaskFlyout
            v-if="flyoutHosted"
            class="border-s-0!"
          />
        </div>
      </div>
    </UDashboardGroup>

    <UDashboardSearch
      v-model:open="searchOpen"
      :groups="searchGroups"
      placeholder="Search pages and tasks…"
    />
  </div>
</template>
