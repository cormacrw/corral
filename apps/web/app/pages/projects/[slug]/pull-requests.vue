<script setup lang="ts">
import type { PullRequestStatus } from '@corral/contracts'
import { api } from '~/composables/useApi'
import type { Color } from '~/utils/labels'
import { ciCell, evidenceCell, mergeCell, rebaseCell, reviewCell } from '~/utils/pull-requests'

// Pull requests (design/pull-requests.md): every open PR in the project and
// where it stands against the merge gates, read live from GitHub
const route = useRoute()
const live = useLive()
const flyout = useTaskFlyout()
const device = useDevice()
const slug = computed(() => String(route.params.slug))
const project = computed(() => live.state.value.projects.find(p => p.slug === slug.value) ?? null)
useSeoMeta({ title: () => `Pull requests · ${project.value?.name ?? ''} · Corral` })

const prs = ref<PullRequestStatus[] | null>(null)
const error = ref<string | null>(null)
const refreshing = ref(false)

let loadingSlug: string | null = null
async function load() {
  const current = slug.value
  if (loadingSlug === current) return
  loadingSlug = current
  refreshing.value = true
  try {
    const next = await api.projects.pullRequests(current)
    if (current !== slug.value) return
    prs.value = next
    error.value = null
  } catch (e) {
    if (current === slug.value) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (loadingSlug === current) loadingSlug = null
    refreshing.value = false
  }
}
watch(slug, () => {
  prs.value = null
  error.value = null
  void load()
}, { immediate: true })

// Live: a task change in this project can change its PR's gates, and CI and
// the base branch move on GitHub without an event, so it also re-reads
// every 30 seconds while the page is open
let debounce: ReturnType<typeof setTimeout> | null = null
const reload = () => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => void load(), 500)
}
onMounted(() => {
  const stop = live.subscribe((event) => {
    if ((event.type === 'task.updated' || event.type === 'task.created') && event.task.projectId === project.value?.id) reload()
    else if (event.type === 'task.deleted' && event.projectId === project.value?.id) reload()
  })
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void load()
  }, 30_000)
  onBeforeUnmount(() => {
    stop()
    clearInterval(timer)
    if (debounce) clearTimeout(debounce)
  })
})

const rows = computed(() => (prs.value ?? []).map(pr => ({
  pr,
  review: reviewCell(pr),
  ci: ciCell(pr),
  rebase: rebaseCell(pr),
  evidence: evidenceCell(pr),
  merge: mergeCell(pr)
})))
// Spelled out so Tailwind sees every class
const TEXT: Record<Color, string> = {
  primary: 'text-primary', secondary: 'text-secondary', success: 'text-success', info: 'text-info', warning: 'text-warning', error: 'text-error', neutral: 'text-muted'
}
const summary = computed(() => {
  const list = prs.value ?? []
  const eligible = list.filter(pr => pr.merge.eligible && !pr.humanReviewOutstanding).length
  return `${list.length} open ${list.length === 1 ? 'PR' : 'PRs'} · ${eligible} eligible to merge`
})
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <div class="flex h-full min-h-0">
      <div :class="['flex min-w-0 flex-1 flex-col', device.isMobile.value && 'overflow-y-auto overscroll-contain']">
        <MobilePageHeader v-if="device.isMobile.value" />
        <div
          v-if="!device.isMobile.value"
          class="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-default px-4 py-2"
        >
          <h1 class="font-semibold text-highlighted">
            Pull requests
          </h1>
          <span
            v-if="prs"
            class="text-sm text-muted"
          >{{ summary }} · live from GitHub</span>
          <UButton
            label="Refresh"
            icon="i-lucide-refresh-cw"
            variant="outline"
            color="neutral"
            size="sm"
            class="ms-auto"
            :loading="refreshing"
            @click="load"
          />
        </div>

        <UAlert
          v-if="error && !prs"
          color="error"
          variant="subtle"
          :title="error"
          class="m-4"
        />
        <div
          v-else-if="!prs"
          class="flex flex-col gap-3 p-4"
        >
          <USkeleton class="h-10 w-full" />
          <USkeleton class="h-10 w-full" />
          <USkeleton class="h-10 w-full" />
        </div>
        <p
          v-else-if="rows.length === 0"
          class="p-4 text-sm text-muted"
        >
          No open pull requests. They show here once a developer opens one.
        </p>

        <!-- Phones: one card per PR -->
        <ul
          v-else-if="device.isMobile.value"
          class="flex shrink-0 flex-col gap-3 p-4"
        >
          <li
            v-for="row in rows"
            :key="row.pr.taskRef"
          >
            <button
              type="button"
              class="flex w-full flex-col gap-2 rounded-lg border border-default bg-default p-3 text-start active:bg-elevated"
              @click="flyout.open(row.pr.taskRef)"
            >
              <span class="flex items-center gap-2 text-xs text-muted">
                <span class="font-mono">{{ row.pr.taskRef }}</span>
                <span>· PR #{{ row.pr.pr.number }}</span>
                <StatusBadge
                  :status="row.pr.taskStatus"
                  size="xs"
                  class="ms-auto"
                />
              </span>
              <span class="text-sm font-medium text-highlighted">{{ row.pr.taskTitle }}</span>
              <dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
                <template
                  v-for="cell in [
                    { term: 'Review', value: row.review },
                    { term: 'CI', value: row.ci },
                    { term: 'Rebase', value: row.rebase },
                    { term: 'Evidence', value: row.evidence }
                  ]"
                  :key="cell.term"
                >
                  <dt class="text-muted">
                    {{ cell.term }}
                  </dt>
                  <dd>
                    <UBadge
                      :label="cell.value.label"
                      :color="cell.value.color"
                      variant="subtle"
                      size="sm"
                    />
                  </dd>
                </template>
              </dl>
              <span
                :class="['flex items-start gap-1.5 border-t border-default pt-2 text-sm', TEXT[row.merge.color]]"
              >
                <UIcon
                  :name="row.pr.merge.eligible ? (row.pr.humanReviewOutstanding ? 'i-lucide-clock' : 'i-lucide-git-merge') : 'i-lucide-circle-x'"
                  class="mt-0.5 size-4 shrink-0"
                />
                <span>
                  {{ row.merge.label }}
                  <span
                    v-if="row.merge.detail"
                    class="block text-xs text-muted"
                  >{{ row.merge.detail }}</span>
                </span>
              </span>
            </button>
          </li>
        </ul>

        <!-- Desktop: a table; a row opens the task flyout -->
        <div
          v-else
          class="min-h-0 flex-1 overflow-auto overscroll-contain"
        >
          <table class="w-full text-sm">
            <thead class="sticky top-0 bg-default text-start text-xs text-muted">
              <tr class="border-b border-default">
                <th class="px-4 py-2 text-start font-medium">
                  Task
                </th>
                <th class="px-2 py-2 text-start font-medium">
                  PR
                </th>
                <th class="px-2 py-2 text-start font-medium">
                  Review
                </th>
                <th class="px-2 py-2 text-start font-medium">
                  CI
                </th>
                <th class="px-2 py-2 text-start font-medium">
                  Rebase
                </th>
                <th class="px-2 py-2 text-start font-medium">
                  Evidence
                </th>
                <th class="px-4 py-2 text-start font-medium">
                  Merge
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rows"
                :key="row.pr.taskRef"
                tabindex="0"
                :aria-selected="flyout.ref.value === row.pr.taskRef"
                :class="['cursor-pointer border-b border-default align-top hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-none', flyout.ref.value === row.pr.taskRef && 'bg-elevated']"
                @click="flyout.toggle(row.pr.taskRef)"
                @keydown.enter.prevent="flyout.toggle(row.pr.taskRef)"
                @keydown.space.prevent="flyout.toggle(row.pr.taskRef)"
              >
                <!-- Takes the room left over, so the title truncates before the gates do -->
                <td class="w-full max-w-0 px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <span class="shrink-0 font-mono text-xs text-muted">{{ row.pr.taskRef }}</span>
                    <StatusBadge
                      :status="row.pr.taskStatus"
                      size="xs"
                    />
                  </div>
                  <div class="mt-0.5 truncate text-highlighted">
                    {{ row.pr.taskTitle }}
                  </div>
                </td>
                <td class="px-2 py-2.5">
                  <ULink
                    :to="row.pr.pr.url"
                    target="_blank"
                    class="font-mono text-xs whitespace-nowrap"
                    @click.stop
                  >
                    #{{ row.pr.pr.number }}
                  </ULink>
                </td>
                <td
                  v-for="(cell, i) in [row.review, row.ci, row.rebase, row.evidence]"
                  :key="i"
                  class="px-2 py-2.5"
                >
                  <UTooltip
                    :text="cell.detail"
                    :disabled="!cell.detail"
                  >
                    <UBadge
                      :label="cell.label"
                      :color="cell.color"
                      variant="subtle"
                      size="sm"
                      class="whitespace-nowrap"
                    />
                  </UTooltip>
                </td>
                <td class="min-w-56 px-4 py-2.5">
                  <span :class="['flex items-start gap-1.5', TEXT[row.merge.color]]">
                    <UIcon
                      :name="row.pr.merge.eligible ? (row.pr.humanReviewOutstanding ? 'i-lucide-clock' : 'i-lucide-git-merge') : 'i-lucide-circle-x'"
                      class="mt-0.5 size-4 shrink-0"
                    />
                    <span>
                      {{ row.merge.label }}
                      <span
                        v-if="row.merge.detail"
                        class="block text-xs text-muted"
                      >{{ row.merge.detail }}</span>
                    </span>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <TaskFlyout v-if="!device.isMobile.value" />
    </div>
  </UDashboardPanel>
</template>
