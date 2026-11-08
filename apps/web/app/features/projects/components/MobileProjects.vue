<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { inboxQuery } from '~/queries/inbox'
import { reloadShell } from '~/queries/shell'
import { projectCardSummary, projectNeedsYou } from '~/features/projects/utils/projects'
import { ADD_PROJECT_PATH, PROJECT_PAGES, projectPath, type ProjectPage } from '~/utils/routes'

// The mobile Projects tab (design/mobile.md, frame "Projects"): a card per
// project that opens its overview, with shortcuts to Board, Backlog and Settings
const ICONS: Record<ProjectPage, string> = { 'board': 'i-hugeicons-layout-03', 'backlog': 'i-hugeicons-left-to-right-list-bullet', 'pull-requests': 'i-hugeicons-git-pull-request', 'settings': 'i-hugeicons-sliders-horizontal' }
const PAGES = PROJECT_PAGES.map(({ page, short }) => ({ label: short, icon: ICONS[page], page }))
const shell = useShell()
const lists = useAllProjectLists(() => shell.projects)
// The shell keeps the Inbox current, so mounting here never asks again. The
// cards still work without the Needs-you counts.
const { data: inbox } = useQuery({ ...inboxQuery(), refetchOnMount: false })

const cards = computed(() => shell.projects.map((project) => {
  const needsYou = projectNeedsYou(inbox.value ?? null, project.id).length
  return { project, loaded: !(lists.pending.value[project.id] ?? true), ...projectCardSummary(project, lists.tasks.value[project.id] ?? [], needsYou) }
}))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
    <template v-if="!shell.loaded">
      <UiSkeleton
        v-for="n in 2"
        :key="n"
        class="h-40 rounded-lg"
      />
    </template>
    <AppLoadError
      v-if="shell.error"
      :title="shell.error"
      :retry="reloadShell"
    />
    <article
      v-for="card in cards"
      :key="card.project.id"
      class="rounded-lg border border-border"
      :data-testid="`project-${card.project.slug}`"
    >
      <NuxtLink
        :to="projectPath(card.project.slug)"
        class="flex items-center gap-3 p-3.5 pb-2"
      >
        <ProjectThumbnail
          :project="card.project"
          :size="36"
        />
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2">
            <span class="truncate font-semibold text-foreground">{{ card.project.name }}</span>
            <AppBadge
              v-if="card.project.paused"
              label="Paused"
              color="warning"
              variant="subtle"
              size="sm"
            />
          </span>
          <span class="block truncate font-mono text-xs text-muted-foreground">{{ card.project.repository }} · {{ card.project.prefix }}</span>
        </span>
        <Icon
          name="i-hugeicons-arrow-right-01"
          class="size-4 shrink-0 text-muted-foreground/70"
        />
      </NuxtLink>
      <p class="flex items-center gap-2 px-3.5 pb-3 text-xs text-muted-foreground">
        <AgentAvatar
          v-if="card.working"
          :name="card.working.agent"
          size="2xs"
          working
        />
        <UiSkeleton
          v-if="!card.loaded"
          class="h-3 w-40"
        />
        <span v-else>{{ card.line }}</span>
      </p>
      <nav
        :aria-label="`${card.project.name} pages`"
        class="grid grid-cols-4 divide-x divide-border border-t border-border"
      >
        <NuxtLink
          v-for="link in PAGES"
          :key="link.page"
          :to="projectPath(card.project.slug, link.page)"
          class="flex flex-col items-center gap-0.5 py-2.5 text-sm font-medium text-foreground active:bg-muted"
        >
          <Icon
            :name="link.icon"
            class="size-4.5 text-muted-foreground"
          />
          <span>{{ link.label }}<span
            v-if="(link.page === 'board' || link.page === 'backlog') && card.loaded"
            class="ms-1 font-normal text-muted-foreground"
          >{{ card[link.page] }}</span></span>
        </NuxtLink>
      </nav>
    </article>
    <AppButton
      :to="ADD_PROJECT_PATH"
      icon="i-hugeicons-add-01"
      label="Add project"
      variant="outline"
      color="neutral"
      size="lg"
      block
    />
  </div>
</template>
