<script setup lang="ts">
import type { ProjectOverview } from '~/features/projects/composables/useProjectOverview'
import { matchesOverviewEpicFilter } from '~/features/board/utils/board'

const props = defineProps<{ overview: ProjectOverview }>()
const { project, tasks, epics, loading } = props.overview
const route = useRoute()
const router = useRouter()
const tabs = [
  { label: 'Needs you', value: 'needs-you', slot: 'needs-you' as const },
  { label: 'Parents', value: 'epics', slot: 'epics' as const },
  { label: 'Flow', value: 'flow', slot: 'flow' as const },
  { label: 'Activity', value: 'activity', slot: 'activity' as const }
]
const filters = [
  { label: 'Open', value: 'open' },
  { label: 'In Progress', value: 'in-progress' },
  { label: 'Closed', value: 'closed' }
] as const
const tab = computed({
  get: () => tabs.find(item => item.value === route.query.tab)?.value ?? 'needs-you',
  set: (value) => { void router.push({ query: { ...route.query, tab: value } }) }
})
const filter = computed({
  get: () => filters.find(item => item.value === route.query.epicFilter)?.value ?? 'open',
  set: (value) => { void router.push({ query: { ...route.query, epicFilter: value } }) }
})
const matching = computed(() => epics.value.filter(group => group.epic && matchesOverviewEpicFilter(group.epic, tasks.value.filter(task => task.epicId === group.id), filter.value)))
</script>

<template>
  <AppTabs
    v-model="tab"
    :items="tabs"
    class="mx-4 min-w-0 md:mx-0"
  >
    <template #needs-you>
      <slot name="needs-you" />
    </template>
    <template #epics>
      <section>
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <div
            class="flex gap-1"
            aria-label="Filter parent tasks"
          >
            <AppButton
              v-for="item in filters"
              :key="item.value"
              :label="item.label"
              :variant="filter === item.value ? 'solid' : 'ghost'"
              :aria-pressed="filter === item.value"
              size="sm"
              @click="filter = item.value"
            />
          </div>
          <AppButton
            :to="`/projects/${project?.slug}/backlog`"
            label="Open Backlog"
            variant="link"
            size="sm"
            class="ms-auto"
          />
        </div>
        <ul class="flex flex-col gap-3">
          <li
            v-for="group in matching"
            :key="group.id"
          >
            <OverviewEpicCard
              :group="group"
              :tasks="tasks.filter(task => task.epicId === group.id)"
            />
          </li>
          <li v-if="loading">
            <UiSkeleton class="h-16 w-full" />
          </li>
          <li
            v-else-if="matching.length === 0"
            class="py-4 text-sm text-muted-foreground"
          >
            No parent tasks match this filter.
          </li>
        </ul>
      </section>
    </template>
    <template #flow>
      <ProjectFlow
        v-if="project"
        :slug="project.slug"
      />
    </template>
    <template #activity>
      <slot name="activity" />
    </template>
  </AppTabs>
</template>
