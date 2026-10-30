<script setup lang="ts">
import type { RunnerStatus } from '@corral/contracts'
import { dashboardCounts } from '~/utils/dashboard'
import { plural } from '~/utils/labels'

const isPrototype = import.meta.prototype
const { state } = useLive()
const route = useRoute()
const router = useRouter()
const option = computed(() => ['b', 'c'].includes(String(route.query.option)) ? String(route.query.option) : 'a')
const preview = computed(() => import.meta.prototype ? String(route.query.state ?? 'default') : 'default')
let originalRunner: RunnerStatus | null = null
watch([preview, () => !!state.value.runner], ([value]) => {
  if (!import.meta.prototype || !state.value.runner) return
  originalRunner ??= JSON.parse(JSON.stringify(state.value.runner)) as RunnerStatus
  state.value.runner = value === 'offline'
    ? { ...originalRunner, online: false, runners: originalRunner.runners.map(r => ({ ...r, online: false, slotsInUse: 0 })) }
    : originalRunner
}, { immediate: true })
onBeforeUnmount(() => {
  if (originalRunner) state.value.runner = originalRunner
})
const projects = computed(() => preview.value === 'no-projects' ? [] : state.value.projects)
const entries = computed(() => (preview.value === 'empty' ? [] : projects.value).flatMap(project => (state.value.epics[project.id] ?? []).map(epic => ({ epic, project, tasks: (state.value.tasks[project.id] ?? []).filter(t => t.epicId === epic.id) }))))
// All merged epic-branch tasks still need the epic PR to reach the target branch.
const open = computed(() => preview.value === 'empty' ? [] : entries.value.filter(({ epic }) => epic.taskCount > 0 && (epic.mergedCount < epic.taskCount || (epic.reviewMode !== 'direct' && epic.reviewState !== 'merged'))).sort((a, b) => b.epic.updatedAt.localeCompare(a.epic.updatedAt)))
function completedAt(entry: typeof entries.value[number]) {
  const times = entry.tasks.flatMap(t => t.mergedAt ? [Date.parse(t.mergedAt)] : [])
  return times.length ? Math.max(...times) : Date.parse(entry.epic.updatedAt)
}
const completed = computed(() => preview.value === 'empty' ? [] : entries.value.filter(entry => entry.epic.taskCount > 0 && entry.epic.mergedCount === entry.epic.taskCount && (entry.epic.reviewMode === 'direct' || entry.epic.reviewState === 'merged') && completedAt(entry) >= Date.now() - 14 * 86400000).sort((a, b) => completedAt(b) - completedAt(a)))
const tasks = computed(() => projects.value.flatMap(p => state.value.tasks[p.id] ?? []))
const counts = computed(() => dashboardCounts(tasks.value))
const failed = computed(() => tasks.value.filter(t => t.status === 'failed').length)
const epicReviews = computed(() => entries.value.filter(e => e.epic.reviewState === 'human_review').length)
const featuredReview = computed(() => entries.value.find(e => e.epic.reviewState === 'human_review'))
const timeline = computed(() => [...open.value.map(entry => ({ ...entry, completed: false, at: Date.parse(entry.epic.updatedAt) })), ...completed.value.map(entry => ({ ...entry, completed: true, at: completedAt(entry) }))].sort((a, b) => b.at - a.at))
const captions: Record<string, string> = { a: 'Projects at a glance', b: 'Keep the bigger picture moving', c: 'A little attention goes a long way' }
function change(key: string, value: string) {
  void router.replace({ query: { ...route.query, [key]: value } })
}
</script>

<template>
  <UDashboardPanel>
    <div
      data-home="desktop"
      :data-option="option"
      :data-screen-id="`home-desktop-option-${option}`"
    >
      <header data-home="home-heading">
        <div>
          <p class="mb-1 text-xs text-muted">
            ALL PROJECTS
          </p><h1 class="text-3xl font-semibold text-highlighted">
            Home
          </h1><p class="mt-1 text-sm text-muted">
            {{ captions[option] }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Home layout"
            class="flex rounded-lg border border-default p-1"
          >
            <UButton
              v-for="key in ['a', 'b', 'c']"
              :key="key"
              :label="`Option ${key.toUpperCase()}`"
              :variant="option === key ? 'soft' : 'ghost'"
              :color="option === key ? 'primary' : 'neutral'"
              :aria-pressed="option === key"
              size="sm"
              @click="change('option', key)"
            />
          </div>
          <select
            v-if="isPrototype"
            aria-label="Preview state"
            class="rounded-md border border-default bg-default p-2 text-xs text-muted"
            :value="preview"
            @change="change('state', ($event.target as HTMLSelectElement).value)"
          >
            <option value="default">
              Populated
            </option><option value="empty">
              Empty epics
            </option><option value="loading">
              Loading
            </option><option value="no-projects">
              No projects
            </option><option value="offline">
              Runner offline
            </option>
          </select>
        </div>
      </header>
      <div
        v-if="preview === 'loading' || !state.loaded || projects.some(p => !state.tasks[p.id])"
        class="space-y-5"
        aria-label="Loading Home"
        aria-busy="true"
      >
        <USkeleton class="h-24 w-full" /><USkeleton class="h-64 w-full" />
      </div>
      <div
        v-else-if="!projects.length"
        class="rounded-lg border border-dashed border-default p-12 text-center"
      >
        <h2 class="text-lg font-semibold">
          A home for your projects
        </h2><p class="mt-2 text-sm text-muted">
          Add your first project to see work across Corral.
        </p><UButton
          to="/setup?step=repo&add=1"
          class="mt-4"
          label="Add project"
        />
      </div>
      <div
        v-else
        data-home="home-layout"
      >
        <section
          data-home="attention-section"
          class="rounded-lg border border-default p-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-highlighted">
              <UIcon
                name="i-lucide-inbox"
                class="size-4 text-primary"
              />Needs you
            </h2><NuxtLink
              to="/inbox"
              class="text-xs text-primary"
            >Open Inbox · {{ state.inboxCount }} →</NuxtLink>
          </div>
          <div class="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <NuxtLink to="/inbox">{{ plural(counts.waitingForReview + epicReviews, 'human review') }}</NuxtLink>
            <NuxtLink
              :to="counts.blocked - failed === 1 ? `/tasks/${tasks.find(t => t.status === 'blocked')?.ref}` : '/inbox'"
              class="text-error"
            >{{ counts.blocked - failed }} blocked</NuxtLink>
            <NuxtLink
              :to="failed === 1 ? `/tasks/${tasks.find(t => t.status === 'failed')?.ref}` : '/inbox'"
              class="text-error"
            >{{ failed }} failed</NuxtLink>
            <span class="text-xs text-muted">Counts overlap with Inbox</span>
          </div>
          <NuxtLink
            v-if="option === 'c' && featuredReview"
            :to="`/epics/${featuredReview.epic.id}`"
            class="mt-4 flex items-center gap-3 border-t border-default pt-4 text-sm"
          ><UIcon
            name="i-lucide-git-pull-request"
            class="size-5 text-warning"
          /><span><strong class="font-medium">{{ featuredReview.epic.title }} is ready for your review</strong><span class="mt-0.5 block text-xs text-muted">{{ featuredReview.project.name }} · Epic PR #{{ featuredReview.epic.prNumber }} · All {{ featuredReview.epic.taskCount }} tasks merged into the epic branch</span></span><UIcon
            name="i-lucide-arrow-right"
            class="ms-auto size-4"
          /></NuxtLink>
        </section>
        <section data-home="projects-section">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-highlighted">
              Projects <span class="ms-1 font-normal text-muted">{{ projects.length }}</span>
            </h2><span class="text-xs text-muted">Today</span>
          </div>
          <div data-home="project-cards">
            <HomeProjectSummary
              v-for="project in projects"
              :key="project.id"
              :project="project"
              :tasks="state.tasks[project.id] ?? []"
              :epic-reviews="entries.filter(e => e.project.id === project.id && e.epic.reviewState === 'human_review').length"
            />
          </div>
        </section>
        <section
          v-if="option !== 'c'"
          data-home="open-section"
        >
          <div data-home="section-title">
            <h2>Open epics <span class="ms-1 font-normal text-muted">{{ open.length }}</span></h2><span class="text-xs font-normal text-muted">{{ option === 'c' ? 'Latest activity first' : 'Across all projects' }}</span>
          </div>
          <HomeEpicList :entries="open" />
        </section>
        <section
          v-if="option !== 'c'"
          data-home="completed-section"
        >
          <div data-home="section-title">
            <h2>Recently completed</h2><span class="text-xs font-normal text-muted">Last 14 days</span>
          </div>
          <HomeEpicList
            :entries="completed"
            completed
          />
        </section>
        <section
          v-if="option === 'c'"
          data-home="timeline-section"
        >
          <div data-home="section-title">
            <h2>Epic activity</h2><span class="text-xs font-normal text-muted">{{ open.length }} open · {{ completed.length }} completed in 14 days</span>
          </div>
          <div data-home="timeline">
            <div
              v-for="entry in timeline"
              :key="entry.epic.id"
              data-home="timeline-entry"
            >
              <HomeEpicList
                :entries="[entry]"
                :completed="entry.completed"
              />
            </div>
            <HomeEpicList
              v-if="!open.length"
              :entries="[]"
            />
            <HomeEpicList
              v-if="!completed.length"
              :entries="[]"
              completed
            />
          </div>
        </section>
        <footer
          data-home="home-footer"
          class="text-xs text-muted"
        >
          Live overview · Project counts include standalone tasks. Epic progress counts board tasks.
        </footer>
      </div>
    </div>
  </UDashboardPanel>
</template>

<style scoped>
[data-home="desktop"] { width: 100%; max-width: 1600px; margin: 0 auto; padding: 32px 36px; overflow-y: auto; }
[data-home="home-heading"] { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 20px; margin-bottom: 24px; }
[data-home="home-layout"] { display: grid; gap: 24px; }
[data-home="section-title"] { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 6px; font-size: 14px; font-weight: 600; color: var(--ui-text-highlighted); }
[data-home="project-cards"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
[data-option="a"] [data-home="home-layout"] { gap: 20px; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); }
[data-option="a"] [data-home="attention-section"], [data-option="a"] [data-home="projects-section"], [data-home="home-footer"] { grid-column: 1 / -1; }
[data-option="a"] [data-home="projects-section"] { grid-row: 1; }
[data-option="a"] [data-home="attention-section"] { grid-row: 2; }
[data-option="b"] [data-home="home-layout"] { grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: auto auto 1fr; align-items: start; }
[data-option="b"] [data-home="attention-section"] { grid-column: 1; grid-row: 1; }
[data-option="b"] [data-home="open-section"] { grid-column: 1; grid-row: 2; }
[data-option="b"] [data-home="projects-section"] { grid-column: 2; grid-row: 1 / 4; border-left: 1px solid var(--ui-border); padding-left: 24px; }
[data-option="b"] [data-home="project-cards"] { grid-template-columns: 1fr; }
[data-option="b"] [data-home="completed-section"] { grid-column: 1; }
[data-option="c"] [data-home="home-layout"] { grid-template-columns: 270px minmax(0, 1fr); align-items: start; }
[data-option="c"] [data-home="attention-section"] { grid-column: 1 / -1; border-color: color-mix(in oklab, var(--ui-primary) 35%, var(--ui-border)); background: color-mix(in oklab, var(--ui-primary) 3%, var(--ui-bg)); }
[data-option="c"] [data-home="projects-section"] { grid-column: 1; grid-row: 2; }
[data-option="c"] [data-home="project-cards"] { grid-template-columns: 1fr; }
[data-home="timeline-section"] { grid-column: 2; min-width: 0; }
[data-home="timeline"] { border-left: 2px solid var(--ui-border); padding-left: 24px; }
[data-home="timeline-entry"] { position: relative; border-bottom: 1px solid var(--ui-border); }
[data-home="timeline-entry"]::before { content: ''; position: absolute; width: 8px; height: 8px; border-radius: 50%; background: var(--ui-primary); left: -29px; top: 20px; }

@media (max-width: 1200px) { [data-home="desktop"] { padding: 24px; } [data-option="b"] [data-home="home-layout"] { grid-template-columns: minmax(0, 1fr) 260px; } [data-option="c"] [data-home="home-layout"] { grid-template-columns: 240px minmax(0, 1fr); } }
@media (max-width: 760px) { [data-home="desktop"] { padding: 20px 16px; } [data-home="home-layout"], [data-option="a"] [data-home="home-layout"], [data-option="b"] [data-home="home-layout"], [data-option="c"] [data-home="home-layout"] { display: flex; flex-direction: column; } [data-home="home-layout"] > * { width: 100%; } [data-home="project-cards"] { grid-template-columns: 1fr; } [data-option="b"] [data-home="projects-section"] { border: 0; padding: 0; } }
</style>
