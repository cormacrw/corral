<script setup lang="ts">
import { runPath } from '~/utils/routes'
import { isActiveRun } from '@corral/core'
import type { AgentRuns } from '~/features/agents/composables/useAgentRuns'
import { duration, runRef, runTitle, timeAgo } from '~/utils/labels'

// An agent's page on the web (design/agent.md): the header, stats and runs
// list, with the selected run in the slot.
const props = defineProps<{ view: AgentRuns }>()
const { name, agent, missing, runs, error, now, selected, load, projectName } = props.view
const router = useRouter()
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
    <AgentHeader
      :agent="agent"
      :view="view"
    />

    <div class="flex min-h-0 flex-1">
      <div class="flex w-80 shrink-0 flex-col border-e border-border">
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
            <button
              type="button"
              :aria-current="selected?.id === run.id ? 'true' : undefined"
              :class="['flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-start text-sm', selected?.id === run.id && 'bg-muted', isActiveRun(run.state) && 'border-s-2 border-s-primary']"
              @click="router.push(runPath(name, run.id))"
            >
              <span class="flex items-center gap-2">
                <span class="font-mono text-xs text-muted-foreground">{{ runRef(run) }}</span>
                <span class="ms-auto text-xs text-muted-foreground/70">{{ timeAgo(run.queuedAt, now) }}</span>
              </span>
              <span class="truncate">{{ runTitle(run) }}</span>
              <span class="text-xs text-muted-foreground">{{ projectName(run) }} · Run #{{ run.number }} · {{ duration(run.startedAt, run.endedAt, now) }}</span>
              <span
                v-if="run.error"
                class="line-clamp-3 text-xs text-destructive"
                :title="run.error"
              >{{ run.error }}</span>
            </button>
          </li>
          <li
            v-if="runs.length === 0"
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
