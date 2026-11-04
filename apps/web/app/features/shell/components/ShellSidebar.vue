<script setup lang="ts">
import { planAttention } from '~/features/plan/utils/plan-attention'
import { isWorking, ROLE } from '~/utils/labels'

// The app shell's navigation (design/app-shell.md): global nav, projects,
// agents and the runner. Opens the search palette through `search`.
const emit = defineEmits<{ search: [] }>()
const { shell, counts, isActive, isExpanded, toggle, runnerTone, statusOf, runnerSummary } = useSidebarData()
const { sessions: threads } = useOpenPlanSessions()
const route = useRoute()

const attentionCount = computed(() => threads.value.filter(s => planAttention(s)).length)
const currentSlug = computed(() => typeof route.params.slug === 'string' ? route.params.slug : null)
const RUNNER_DOT = { success: 'bg-success', warning: 'bg-warning', error: 'bg-destructive' }
const PROJECT_PAGES = [
  { path: 'board', label: 'Board', count: 'board' },
  { path: 'backlog', label: 'Backlog', count: 'backlog' },
  { path: 'pull-requests', label: 'Pull requests' },
  { path: 'settings', label: 'Settings' }
] as const
</script>

<template>
  <UiSidebar
    collapsible="icon"
    class="absolute! h-full!"
  >
    <UiSidebarHeader>
      <NuxtLink
        to="/"
        class="flex items-center gap-2 p-1 font-semibold"
      >
        <AppLogo class="size-6" />
        <span class="group-data-[collapsible=icon]:hidden">Corral</span>
      </NuxtLink>
      <UiSidebarMenu>
        <UiSidebarMenuItem>
          <UiSidebarMenuButton
            tooltip="Search"
            variant="outline"
            @click="emit('search')"
          >
            <Icon name="i-hugeicons-search-01" />
            <span>Search…</span>
            <UiKbd class="ms-auto group-data-[collapsible=icon]:hidden">
              ⌘K
            </UiKbd>
          </UiSidebarMenuButton>
        </UiSidebarMenuItem>
      </UiSidebarMenu>
    </UiSidebarHeader>

    <UiSidebarContent>
      <UiSidebarGroup>
        <nav aria-label="Global">
          <UiSidebarMenu>
            <ShellNavItem
              to="/plan"
              label="Plan"
              icon="i-hugeicons-message-01"
              :active="isActive('/plan')"
              :badge="attentionCount"
              :badge-label="`${attentionCount} threads need attention`"
            />
            <ShellThreads />
            <ShellNavItem
              to="/inbox"
              label="Inbox"
              icon="i-hugeicons-inbox"
              :active="isActive('/inbox')"
              :badge="shell.inboxCount"
            />
          </UiSidebarMenu>
        </nav>
      </UiSidebarGroup>

      <UiSidebarGroup>
        <UiSidebarGroupLabel>Projects</UiSidebarGroupLabel>
        <UiSidebarGroupAction
          as-child
          title="Add project"
        >
          <NuxtLink
            to="/setup?step=repo&add=1"
            aria-label="Add project"
          >
            <Icon name="i-hugeicons-add-01" />
          </NuxtLink>
        </UiSidebarGroupAction>
        <UiSidebarMenu>
          <UiSidebarMenuItem
            v-for="project in shell.projects"
            :key="project.id"
            role="group"
            :aria-label="project.name"
          >
            <UiSidebarMenuButton
              as-child
              :tooltip="project.name"
              :is-active="currentSlug === project.slug"
            >
              <NuxtLink :to="`/projects/${project.slug}`">
                <ProjectThumbnail
                  :project="project"
                  :size="16"
                />
                <span class="truncate">{{ project.name }}</span>
                <span
                  v-if="project.paused"
                  class="ms-1 shrink-0 text-xs text-warning"
                >Paused</span>
              </NuxtLink>
            </UiSidebarMenuButton>
            <UiSidebarMenuAction
              :aria-expanded="isExpanded(project)"
              :aria-label="`${isExpanded(project) ? 'Collapse' : 'Expand'} ${project.name}`"
              @click="toggle(project)"
            >
              <Icon :name="isExpanded(project) ? 'i-hugeicons-arrow-down-01' : 'i-hugeicons-arrow-right-01'" />
            </UiSidebarMenuAction>
            <UiSidebarMenuSub v-if="isExpanded(project)">
              <UiSidebarMenuSubItem
                v-for="page in PROJECT_PAGES"
                :key="page.path"
              >
                <UiSidebarMenuSubButton
                  as-child
                  :is-active="isActive(`/projects/${project.slug}/${page.path}`)"
                >
                  <NuxtLink :to="`/projects/${project.slug}/${page.path}`">
                    <span>{{ page.label }}</span>
                    <span
                      v-if="'count' in page"
                      class="ms-auto text-xs text-muted-foreground"
                    >{{ counts.get(project.id)?.[page.count] }}</span>
                  </NuxtLink>
                </UiSidebarMenuSubButton>
              </UiSidebarMenuSubItem>
            </UiSidebarMenuSub>
          </UiSidebarMenuItem>
        </UiSidebarMenu>
      </UiSidebarGroup>

      <UiSidebarGroup>
        <UiSidebarGroupLabel>Agents</UiSidebarGroupLabel>
        <UiSidebarMenu>
          <UiSidebarMenuItem
            v-for="agent in shell.agents"
            :key="agent.id"
          >
            <UiSidebarMenuButton
              as-child
              :tooltip="`${agent.name} · ${ROLE[agent.role]}`"
              :is-active="isActive(`/agents/${agent.name.toLowerCase()}`)"
            >
              <NuxtLink :to="`/agents/${agent.name.toLowerCase()}`">
                <!-- Nav icon size, so rows stay one height and fit when collapsed -->
                <AgentAvatar
                  :name="agent.name"
                  :working="isWorking(agent)"
                  size="2xs"
                />
                <span class="min-w-0 truncate">{{ agent.name }} <span class="text-muted-foreground">· {{ ROLE[agent.role] }}</span></span>
                <span
                  v-if="statusOf(agent)"
                  class="ms-auto min-w-0 truncate text-xs text-muted-foreground"
                  :title="statusOf(agent)"
                >{{ statusOf(agent) }}</span>
              </NuxtLink>
            </UiSidebarMenuButton>
          </UiSidebarMenuItem>
        </UiSidebarMenu>
      </UiSidebarGroup>

      <UiSidebarGroup class="mt-auto">
        <UiSidebarMenu>
          <ShellNavItem
            to="/settings/profile"
            label="Settings"
            icon="i-hugeicons-settings-01"
            :active="isActive('/settings')"
          />
        </UiSidebarMenu>
      </UiSidebarGroup>
    </UiSidebarContent>

    <UiSidebarFooter>
      <div class="flex items-center gap-2 rounded-md bg-sidebar-accent p-2 text-xs group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-1">
        <span class="relative inline-flex shrink-0">
          <Icon
            name="i-hugeicons-server-stack-01"
            class="size-4 text-muted-foreground"
          />
          <span
            :class="['absolute -end-0.5 -top-0.5 size-2 rounded-full ring-2 ring-sidebar-accent', RUNNER_DOT[runnerTone]]"
            aria-hidden="true"
          />
        </span>
        <div class="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <div class="font-medium">
            Runner {{ shell.runner?.online ? 'online' : 'offline' }}
          </div>
          <div class="truncate text-muted-foreground">
            {{ runnerSummary(shell.runner) }}
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2 group-data-[collapsible=icon]:flex-col">
        <AgentAvatar
          name="You"
          size="sm"
        />
        <span class="flex-1 truncate text-sm group-data-[collapsible=icon]:hidden">You</span>
        <AppColorModeButton />
        <UiSidebarTrigger />
      </div>
    </UiSidebarFooter>
    <UiSidebarRail />
  </UiSidebar>
</template>
