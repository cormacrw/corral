<script setup lang="ts">
import type { ProjectOverview } from '~/composables/useProjectOverview'
import { duration, inboxTypeBadge, initials, projectColor, STATUS, timeAgo } from '~/utils/labels'

// Project overview on mobile (design/mobile.md, frame "Project overview").
// The same sections as the web page in one column, with links to the
// Board and Backlog. The in-page title row holds Back and Settings.
const props = defineProps<{ overview: ProjectOverview }>()
const { project, tasks, runs, history, error, load, DOT, count, needsYou, mergedThisWeek, firstPass, waitingOnDependency, developer, reviewer, pmName, epics, taskOf, actorName, taskRefOf, activityText } = props.overview
</script>

<template>
  <!-- The layout bounds this single scroller above the tab bar and safe area.
       Clip the active runs' glow horizontally without nesting a scroller. -->
  <div class="min-w-0 flex-1 overflow-x-hidden">
    <MobilePageHeader />
    <div
      v-if="!project"
      class="flex flex-col gap-3 p-4"
    >
      <USkeleton class="h-11 w-56" />
      <USkeleton class="h-24 w-full" />
    </div>
    <div
      v-else
      class="flex flex-col gap-6 py-4"
    >
      <header class="flex flex-col gap-4 px-4">
        <div class="flex items-center gap-3">
          <span
            class="flex size-11 shrink-0 items-center justify-center rounded-lg text-lg font-semibold text-white"
            :style="{ background: projectColor(project) }"
            aria-hidden="true"
          >{{ initials(project.name) }}</span>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="truncate text-2xl font-semibold text-highlighted">
                {{ project.name }}
              </h2>
              <UBadge
                v-if="project.paused"
                label="Paused"
                color="warning"
                variant="subtle"
              />
            </div>
            <p class="truncate text-xs text-muted">
              <span class="font-mono">github.com/{{ project.repository }}</span> · {{ project.defaultBranch }} · {{ project.prefix }}-{{ project.nextTaskNumber }}
            </p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <UButton
            :to="`/plan?project=${project.id}`"
            :label="`Plan with ${pmName}`"
            variant="outline"
            color="neutral"
            icon="i-lucide-message-square"
            size="lg"
            block
          />
          <UButton
            :to="`/projects/${project.slug}/board`"
            label="Open board"
            icon="i-lucide-square-kanban"
            size="lg"
            block
          />
        </div>
      </header>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error"
        :actions="[{ label: 'Retry', onClick: load }]"
        class="mx-4 w-auto"
      />

      <div
        v-if="tasks.length === 0"
        class="mx-4 rounded-lg border border-default p-6 text-center"
      >
        <p class="mb-3 text-muted">
          Plan your first epic with {{ pmName }}
        </p>
        <UButton
          :to="`/plan?project=${project.id}`"
          :label="`Plan with ${pmName}`"
        />
      </div>

      <!-- Stat tiles scroll sideways rather than wrap -->
      <div class="flex snap-x scroll-px-4 gap-2 overflow-x-auto overscroll-x-contain px-4">
        <dl
          v-for="tile in [
            { label: 'Ready', color: STATUS.ready.color, value: count('ready'), sub: waitingOnDependency ? `${waitingOnDependency} waiting on a dependency` : 'scheduled next' },
            { label: 'In progress', color: STATUS.in_progress.color, value: count('in_progress'), sub: developer ? `${developer} working` : 'no run active' },
            { label: 'Agent review', color: STATUS.agent_review.color, value: count('agent_review'), sub: reviewer ? `${reviewer} reviewing` : 'waiting' },
            { label: 'Needs you', color: STATUS.human_review.color, value: needsYou.length, sub: `${count('human_review')} review · ${count('blocked')} blocked · ${count('failed')} failed` },
            { label: 'Merged this week', color: STATUS.merged.color, value: mergedThisWeek.length, sub: firstPass === null ? 'no merges yet' : `first-pass approval ${firstPass}%` }
          ]"
          :key="tile.label"
          class="w-33 shrink-0 snap-start rounded-lg border border-default p-3"
        >
          <dt class="flex items-center gap-1.5 truncate text-xs text-muted">
            <span
              :class="['size-2 shrink-0 rounded-full', DOT[tile.color]]"
              aria-hidden="true"
            />{{ tile.label }}
          </dt>
          <dd class="text-2xl font-semibold tabular-nums">
            {{ tile.value }}
          </dd>
          <dd class="text-xs text-muted">
            {{ tile.sub }}
          </dd>
        </dl>
      </div>

      <section>
        <div class="mb-2 flex items-center gap-2 px-4">
          <h3 class="text-sm font-semibold text-highlighted">
            Needs you
          </h3>
          <UBadge
            :label="String(needsYou.length)"
            size="sm"
            :color="needsYou.length ? 'primary' : 'neutral'"
            :variant="needsYou.length ? 'solid' : 'subtle'"
          />
          <UButton
            to="/inbox"
            label="Open Inbox"
            variant="link"
            class="ms-auto px-0"
          />
        </div>
        <ul
          v-if="needsYou.length > 0"
          class="divide-y divide-default border-y border-default"
        >
          <li
            v-for="item in needsYou"
            :key="item.id"
          >
            <NuxtLink
              :to="`/inbox/${item.id}`"
              class="flex items-center gap-2 px-4 py-3 active:bg-elevated"
            >
              <span class="min-w-0 flex-1">
                <span class="flex items-baseline gap-2">
                  <span class="shrink-0 font-mono text-xs text-muted">{{ item.taskRef }}</span>
                  <span class="truncate text-sm">{{ item.subject }}</span>
                </span>
                <span class="mt-1 flex items-center gap-2">
                  <UBadge
                    :label="inboxTypeBadge(item.type).label"
                    :color="inboxTypeBadge(item.type).color"
                    variant="subtle"
                    size="sm"
                  />
                  <span class="text-xs text-dimmed">{{ timeAgo(item.at) }}</span>
                </span>
              </span>
              <UIcon
                name="i-lucide-chevron-right"
                class="size-4 shrink-0 text-dimmed"
              />
            </NuxtLink>
          </li>
        </ul>
        <p
          v-else
          class="px-4 text-sm text-muted"
        >
          Nothing is waiting on you.
        </p>
      </section>

      <section class="px-4">
        <h3 class="mb-2 text-sm font-semibold text-highlighted">
          Active now
        </h3>
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
              class="flex items-center gap-3 rounded-lg border border-primary/40 p-3 active:bg-elevated"
            >
              <AgentAvatar
                :name="run.agentName"
                working
              />
              <div class="min-w-0">
                <p class="truncate text-sm">
                  <span class="font-medium">{{ run.agentName }}</span> is {{ run.role === 'reviewer' ? 'reviewing' : run.role === 'pm' ? 'planning' : 'building' }} {{ run.taskRef ?? '' }} {{ taskOf(run)?.title ?? '' }}
                </p>
                <p class="text-xs text-muted">
                  Run #{{ run.number }} · {{ duration(run.startedAt ?? run.queuedAt, null) }} · {{ run.state.replace('_', ' ') }}
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

      <section class="px-4">
        <div class="mb-2 flex items-center">
          <h3 class="text-sm font-semibold text-highlighted">
            Epics
          </h3>
          <UButton
            :to="`/projects/${project.slug}/backlog`"
            label="Open Backlog"
            variant="link"
            class="ms-auto px-0"
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
            />
          </li>
          <li
            v-if="epics.length === 0"
            class="text-sm text-muted"
          >
            No epics yet.
          </li>
        </ul>
      </section>

      <section class="px-4">
        <h3 class="mb-2 text-sm font-semibold text-highlighted">
          Recent activity
        </h3>
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
            <span class="min-w-0">
              <span class="font-medium">{{ actorName(entry) }}</span>{{ ' ' }}
              <span class="text-muted">{{ activityText(entry) }}</span>{{ ' ' }}
              <NuxtLink
                :to="`/tasks/${taskRefOf(entry)}`"
                class="font-mono text-xs text-muted"
              >{{ taskRefOf(entry) }}</NuxtLink>
              <span class="ms-2 text-xs text-dimmed">{{ timeAgo(entry.createdAt) }}</span>
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
</template>
