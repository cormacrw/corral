<script setup lang="ts">
import type { Inbox } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { initials, projectColor } from '~/utils/labels'
import { projectCardSummary } from '~/utils/projects'

// The mobile Projects tab (design/mobile.md, frame "Projects"): a card per
// project that opens its overview, with shortcuts to Board, Backlog and Settings
const live = useLive()
const state = live.state
const inbox = ref<Inbox | null>(null)

async function loadInbox() {
  try {
    inbox.value = await api.inbox.get()
  } catch {
    // The cards still work without the Needs-you counts
  }
}
onMounted(() => {
  void loadInbox()
  const stop = live.subscribe((event) => {
    if (event.type === 'task.updated' || event.type === 'task.deleted') void loadInbox()
  })
  onBeforeUnmount(stop)
})

const cards = computed(() => state.value.projects.map((project) => {
  const needsYou = inbox.value?.needsYou.filter(i => i.project.id === project.id).length ?? 0
  return { project, loaded: Boolean(state.value.tasks[project.id]), ...projectCardSummary(project, state.value.tasks[project.id] ?? [], state.value.agents, needsYou) }
}))
</script>

<template>
  <MobileHeader title="Projects">
    <UButton
      to="/setup?step=repo&add=1"
      icon="i-lucide-plus"
      variant="ghost"
      color="neutral"
      aria-label="Add project"
    />
  </MobileHeader>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
    <template v-if="!state.loaded">
      <USkeleton
        v-for="n in 2"
        :key="n"
        class="h-40 rounded-lg"
      />
    </template>
    <UAlert
      v-if="state.error"
      color="error"
      variant="subtle"
      :title="state.error"
      :actions="[{ label: 'Retry', onClick: () => live.load() }]"
    />
    <article
      v-for="card in cards"
      :key="card.project.id"
      class="rounded-lg border border-default"
      :data-testid="`project-${card.project.slug}`"
    >
      <NuxtLink
        :to="`/projects/${card.project.slug}`"
        class="flex items-center gap-3 p-3.5 pb-2"
      >
        <span
          class="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
          :style="{ background: projectColor(card.project) }"
          aria-hidden="true"
        >{{ initials(card.project.name) }}</span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2">
            <span class="truncate font-semibold text-highlighted">{{ card.project.name }}</span>
            <UBadge
              :label="card.project.paused ? 'Paused' : 'Running'"
              :color="card.project.paused ? 'warning' : 'success'"
              variant="subtle"
              size="sm"
            />
          </span>
          <span class="block truncate font-mono text-xs text-muted">{{ card.project.repository }} · {{ card.project.prefix }}</span>
        </span>
        <UIcon
          name="i-lucide-chevron-right"
          class="size-4 shrink-0 text-dimmed"
        />
      </NuxtLink>
      <p class="flex items-center gap-2 px-3.5 pb-3 text-xs text-muted">
        <AgentAvatar
          v-if="card.working"
          :name="card.working.agent"
          size="2xs"
          working
        />
        <USkeleton
          v-if="!card.loaded"
          class="h-3 w-40"
        />
        <span v-else>{{ card.line }}</span>
      </p>
      <nav
        :aria-label="`${card.project.name} pages`"
        class="grid grid-cols-3 divide-x divide-default border-t border-default"
      >
        <NuxtLink
          v-for="link in [
            { label: 'Board', icon: 'i-lucide-square-kanban', to: 'board', count: card.board },
            { label: 'Backlog', icon: 'i-lucide-list', to: 'backlog', count: card.backlog },
            { label: 'Settings', icon: 'i-lucide-sliders-horizontal', to: 'settings', count: null }
          ]"
          :key="link.to"
          :to="`/projects/${card.project.slug}/${link.to}`"
          class="flex flex-col items-center gap-0.5 py-2.5 text-sm font-medium text-highlighted active:bg-elevated"
        >
          <UIcon
            :name="link.icon"
            class="size-4.5 text-muted"
          />
          <span>{{ link.label }}<span
            v-if="link.count !== null && card.loaded"
            class="ms-1 font-normal text-muted"
          >{{ link.count }}</span></span>
        </NuxtLink>
      </nav>
    </article>
    <UButton
      to="/setup?step=repo&add=1"
      icon="i-lucide-plus"
      label="Add project"
      variant="outline"
      color="neutral"
      size="lg"
      block
    />
  </div>
</template>
