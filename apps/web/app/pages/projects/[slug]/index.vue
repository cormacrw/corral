<script setup lang="ts">
import { inboxTypeBadge } from '~/utils/labels'
import TimeAgo from '~/components/TimeAgo.vue'

// Project overview (design/project-overview.md). Mobile gets
// MobileProjectOverview (design/mobile.md) over the same data.
const device = useDevice()
const { overview } = useProject()
const { project, tasks, loading, inboxLoading, runs, history, error, load, needsYou, pmName, epics, taskOf, actorName, taskRefOf, activityText } = overview
useSeoMeta({ title: () => `${project.value?.name ?? 'Project'} · Corral` })
</script>

<template>
  <MobileProjectOverview
    v-if="device.isMobile.value"
    :overview="overview"
  />
  <UDashboardPanel v-else>
    <div
      v-if="!project"
      class="p-6"
    >
      <USkeleton class="h-8 w-64" />
    </div>
    <div
      v-else
      class="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-6"
    >
      <header class="flex flex-wrap items-center gap-4">
        <ProjectThumbnail
          :project="project"
          :size="44"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h1 class="text-2xl font-semibold">
              {{ project.name }}
            </h1>
            <UBadge
              v-if="project.paused"
              label="Paused"
              color="warning"
              variant="subtle"
            />
          </div>
          <p class="text-sm text-muted">
            <span class="font-mono">github.com/{{ project.repository }}</span> · Branch {{ project.defaultBranch }} · Task IDs {{ project.prefix }}-{{ project.nextTaskNumber }}
          </p>
        </div>
        <div class="flex gap-2">
          <UButton
            :to="`/plan?project=${project.id}`"
            :label="`Plan with ${pmName}`"
            variant="outline"
            color="neutral"
            icon="i-lucide-message-square"
          />
          <UButton
            :to="`/projects/${project.slug}/board`"
            label="Open board"
          />
        </div>
      </header>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error"
        :actions="[{ label: 'Retry', onClick: load }]"
      />

      <div
        v-if="!loading && tasks.length === 0"
        class="rounded-lg border border-default p-8 text-center"
      >
        <p class="mb-3 text-muted">
          Plan your first epic with {{ pmName }}
        </p>
        <UButton
          :to="`/plan?project=${project.id}`"
          :label="`Plan with ${pmName}`"
        />
      </div>

      <OverviewTiles :overview="overview" />

      <ProjectFlow
        :slug="project.slug"
      />

      <div class="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-6">
        <div class="flex flex-col gap-6">
          <section class="rounded-lg border border-default">
            <header class="flex items-center gap-2 border-b border-default px-3 py-2">
              <h2 class="font-medium">
                Needs you
              </h2>
              <UBadge
                :label="String(needsYou.length)"
                size="sm"
                :color="needsYou.length ? 'primary' : 'neutral'"
                variant="subtle"
              />
              <UButton
                to="/inbox"
                label="Open Inbox"
                variant="link"
                size="sm"
                class="ms-auto"
              />
            </header>
            <ul v-if="needsYou.length > 0">
              <li
                v-for="item in needsYou"
                :key="item.id"
              >
                <NuxtLink
                  :to="`/inbox/${item.id}`"
                  class="flex items-center gap-2 px-3 py-2 text-sm hover:bg-elevated"
                >
                  <UBadge
                    :label="inboxTypeBadge(item.type).label"
                    :color="inboxTypeBadge(item.type).color"
                    size="xs"
                    variant="subtle"
                    class="shrink-0"
                  />
                  <span class="shrink-0 font-mono text-xs text-muted">{{ item.taskRef }}</span>
                  <span class="min-w-0 flex-1 truncate">{{ item.subject }}</span>
                  <span class="shrink-0 text-xs text-dimmed"><TimeAgo :at="item.at" /></span>
                </NuxtLink>
              </li>
            </ul>
            <div
              v-else-if="inboxLoading"
              class="flex flex-col gap-2 p-3"
            >
              <USkeleton class="h-5 w-full" />
              <USkeleton class="h-5 w-2/3" />
            </div>
            <p
              v-else
              class="px-3 py-4 text-sm text-muted"
            >
              Nothing is waiting on you.
            </p>
          </section>

          <section>
            <h2 class="mb-2 font-medium">
              Active now
            </h2>
            <div
              v-if="runs.length > 0"
              class="flex flex-col gap-2"
            >
              <BorderGlow
                v-for="run in runs"
                :key="run.id"
                :border-radius="8"
              >
                <NuxtLink
                  :to="`/agents/${run.agentName.toLowerCase()}/${run.id}`"
                  class="flex items-center gap-3 rounded-lg border border-primary/40 p-3 outline-primary hover:bg-elevated"
                >
                  <AgentAvatar
                    :name="run.agentName"
                    working
                  />
                  <div class="min-w-0">
                    <p class="truncate text-sm">
                      {{ run.agentName }} is {{ run.role === 'reviewer' ? 'reviewing' : run.role === 'pm' ? 'planning' : 'building' }} {{ run.taskRef ?? (run.epicId ? 'epic' : '') }} {{ taskOf(run)?.title ?? run.epicTitle ?? '' }}
                    </p>
                    <p class="text-xs text-muted">
                      Run #{{ run.number }} · <ElapsedTime :from="run.startedAt ?? run.queuedAt" /> · {{ run.state.replace('_', ' ') }}
                    </p>
                  </div>
                </NuxtLink>
              </BorderGlow>
            </div>
            <p
              v-else
              class="text-sm text-muted"
            >
              No agent is working on this project right now.
            </p>
          </section>
        </div>

        <div class="flex flex-col gap-6">
          <section>
            <div class="mb-2 flex items-center">
              <h2 class="font-medium">
                Epics
              </h2>
              <UButton
                :to="`/projects/${project.slug}/backlog`"
                label="Open Backlog"
                variant="link"
                size="sm"
                class="ms-auto"
              />
            </div>
            <ul class="flex flex-col gap-3">
              <li
                v-for="epic in epics"
                :key="epic.id"
              >
                <EpicProgressRow
                  :id="epic.id"
                  :title="epic.title"
                  :merged="epic.merged"
                  :total="epic.total"
                  :epic="epic.epic"
                />
              </li>
              <li v-if="loading">
                <USkeleton class="h-8 w-full" />
              </li>
              <li
                v-else-if="epics.length === 0"
                class="text-sm text-muted"
              >
                No epics yet.
              </li>
            </ul>
          </section>

          <section>
            <h2 class="mb-2 font-medium">
              Recent activity
            </h2>
            <ol class="flex flex-col gap-2 text-sm">
              <li
                v-for="entry in history"
                :key="entry.id"
                class="flex gap-2"
              >
                <span
                  class="mt-2 size-1.5 shrink-0 rounded-full bg-accented"
                  aria-hidden="true"
                />
                <span class="min-w-0 truncate">
                  <span class="font-medium">{{ actorName(entry) }}</span>{{ ' ' }}
                  <span class="text-muted">{{ activityText(entry) }}</span>{{ ' ' }}
                  <NuxtLink
                    :to="`/tasks/${taskRefOf(entry)}`"
                    class="font-mono text-xs text-muted hover:underline"
                  >{{ taskRefOf(entry) }}</NuxtLink>
                  <span class="ms-2 text-xs text-dimmed"><TimeAgo :at="entry.createdAt" /></span>
                </span>
              </li>
              <li
                v-if="history.length === 0"
                class="text-sm text-muted"
              >
                Nothing yet.
              </li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  </UDashboardPanel>
</template>
