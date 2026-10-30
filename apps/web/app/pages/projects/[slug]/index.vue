<script setup lang="ts">
import { duration, STATUS, timeAgo } from '~/utils/labels'

// Project overview (design/project-overview.md). Mobile gets
// MobileProjectOverview (design/mobile.md) over the same data.
const device = useDevice()
const overview = useProjectOverview()
const { project, tasks, runs, history, error, load, DOT, count, needsYou, mergedThisWeek, firstPass, waitingOnDependency, developer, reviewer, pmName, epics, taskOf, actorName, taskRefOf, activityText } = overview
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
        v-if="tasks.length === 0"
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

      <div class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        <dl
          v-for="tile in [
            { label: 'Ready', color: STATUS.ready.color, value: count('ready'), sub: waitingOnDependency ? `${waitingOnDependency} waiting on a dependency` : 'scheduled next' },
            { label: 'In progress', color: STATUS.in_progress.color, value: count('in_progress'), sub: developer ? `${developer} working` : 'no run active' },
            { label: 'Agent review', color: STATUS.agent_review.color, value: count('agent_review'), sub: reviewer ? `${reviewer} reviewing` : 'waiting' },
            { label: 'Needs you', color: STATUS.human_review.color, value: needsYou.length, sub: `${count('human_review')} review · ${count('blocked')} blocked · ${count('failed')} failed` },
            { label: 'Merged this week', color: STATUS.merged.color, value: mergedThisWeek.length, sub: firstPass === null ? 'no merges yet' : `first-pass approval ${firstPass}%` }
          ]"
          :key="tile.label"
          class="rounded-lg border border-default p-3"
        >
          <dt class="flex items-center gap-1.5 text-xs text-muted">
            <span
              :class="['size-2 rounded-full', DOT[tile.color]]"
              aria-hidden="true"
            />{{ tile.label }}
          </dt>
          <dd class="text-2xl font-semibold tabular-nums">
            {{ tile.value }}
          </dd>
          <dd class="truncate text-xs text-muted">
            {{ tile.sub }}
          </dd>
        </dl>
      </div>

      <ProjectFlow
        :slug="project.slug"
        :project-id="project.id"
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
                    :label="item.type.replace('_', ' ')"
                    size="xs"
                    variant="subtle"
                    :color="item.type === 'human_review' ? 'warning' : 'error'"
                  />
                  <span class="font-mono text-xs text-muted">{{ item.taskRef }}</span>
                  <span class="min-w-0 flex-1 truncate">{{ item.subject }}</span>
                  <span class="text-xs text-dimmed">{{ timeAgo(item.at) }}</span>
                </NuxtLink>
              </li>
            </ul>
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
                <div class="flex justify-between text-sm">
                  <NuxtLink
                    v-if="epic.id !== 'none'"
                    :to="`/epics/${epic.id}`"
                    class="hover:text-primary hover:underline"
                  >{{ epic.title }}</NuxtLink>
                  <span v-else>{{ epic.title }}</span>
                  <span class="text-muted">{{ epic.merged }} of {{ epic.total }} merged</span>
                </div>
                <div
                  role="meter"
                  :aria-label="`${epic.title}: ${epic.merged} of ${epic.total} tasks merged`"
                  :aria-valuenow="epic.merged"
                  aria-valuemin="0"
                  :aria-valuemax="epic.total"
                  class="mt-1 flex h-1.5 gap-0.5"
                >
                  <span
                    class="rounded-full bg-primary"
                    :style="{ flex: epic.merged }"
                  />
                  <span
                    class="rounded-full bg-accented"
                    :style="{ flex: epic.total - epic.merged }"
                  />
                </div>
                <EpicReviewLine
                  v-if="epic.epic"
                  :epic="epic.epic"
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
    </div>
  </UDashboardPanel>
</template>
