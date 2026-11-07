<script setup lang="ts">
import type { AgentRuns } from '~/features/runs/composables/useAgentRuns'
import { plural, ROLE, runtimeLabel } from '~/utils/labels'

// An agent's page on the web (design/agent.md): the header, then its
// activity dashboard, or with a run in the URL the runs list and the
// selected run in the slot
const props = defineProps<{ view: AgentRuns }>()
const { name, agent, status, limited, missing, runs, pending, runsFailed, error, now, selected, load, today, resume, project } = props.view
const router = useRouter()
const route = useRoute()
const open = computed(() => typeof route.params.runId === 'string' && route.params.runId !== '')
</script>

<template>
  <AgentNotFound v-if="missing" />
  <div
    v-else-if="!agent"
    class="p-6"
  >
    <UiSkeleton class="h-8 w-48" />
  </div>
  <div
    v-else
    class="flex h-full min-h-0 flex-col"
  >
    <header class="flex items-center gap-3 border-b border-border px-4 py-3">
      <AgentAvatar
        :name="agent.name"
        :working="agent.activeRuns > 0"
        size="lg"
      />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h1 class="min-w-0 truncate text-lg font-semibold">
            {{ agent.name }}
          </h1>
          <AppBadge
            v-if="status"
            v-bind="status"
            variant="subtle"
          />
        </div>
        <p class="text-sm text-muted-foreground">
          {{ ROLE[agent.role] }} · <span data-testid="agent-runtime-label">{{ runtimeLabel(agent.runtime) }}</span><template v-if="!pending && !runsFailed">
            · {{ plural(today.length, 'run') }} today
          </template>
          <span v-if="limited"> · Waiting on usage limit until {{ new Date(agent.pausedUntil!).toLocaleTimeString() }}</span>
        </p>
      </div>
      <AppButton
        v-if="limited"
        label="Resume now"
        variant="outline"
        color="neutral"
        size="sm"
        @click="resume"
      />
      <AppButton
        to="/settings/agents"
        label="Agent settings"
        variant="outline"
        color="neutral"
        size="sm"
      />
    </header>
    <AgentDashboard
      v-if="!open"
      :view="view"
    />
    <div
      v-else
      class="flex min-h-0 flex-1"
    >
      <div class="flex w-80 shrink-0 flex-col border-e border-border">
        <NuxtLink
          :to="`/agents/${name}`"
          class="flex items-center gap-1.5 border-b border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          data-testid="agent-activity-link"
        >
          <Icon
            name="i-hugeicons-arrow-left-01"
            class="size-4"
          />
          Activity
        </NuxtLink>
        <AppLoadError
          v-if="error"
          :title="error"
          :retry="load"
          class="m-3 w-auto"
        />
        <ul class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <li
            v-for="run in runs"
            :key="run.id"
          >
            <AgentRunRow
              :run="run"
              :project="project(run)"
              :now="now"
              :selected="selected?.id === run.id"
              @click="router.push(`/agents/${name}/${run.id}`)"
            />
          </li>
          <li
            v-if="!pending && !runsFailed && runs.length === 0"
            class="p-4 text-sm text-muted-foreground"
          >
            No runs yet.
          </li>
        </ul>
      </div>

      <slot />
    </div>
  </div>
</template>
