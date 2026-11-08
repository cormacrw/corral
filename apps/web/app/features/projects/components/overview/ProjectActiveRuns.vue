<script setup lang="ts">
import { runPath } from '~/utils/routes'
import type { Run, Task } from '@corral/contracts'

defineProps<{ runs: Run[], taskOf: (run: Run) => Task | undefined, mobile?: boolean }>()
const verb = (run: Run) => run.role === 'reviewer' ? 'reviewing' : run.role === 'pm' ? 'planning' : 'building'
</script>

<template>
  <section :class="mobile && 'px-4'">
    <OverviewHeading
      :mobile="mobile"
      class="mb-2"
    >
      Active now
    </OverviewHeading>
    <div
      v-if="runs.length > 0"
      class="flex flex-col gap-2"
    >
      <BorderGlow
        v-for="run in runs"
        :key="run.id"
        :border-radius="8"
      >
        <!-- The run link covers the card, so the task link can sit beside it, not inside it -->
        <div :class="['relative flex items-center gap-3 rounded-lg border border-primary/40 p-3', mobile ? 'active:bg-muted' : 'hover:bg-muted']">
          <AgentAvatar
            :name="run.agentName"
            working
          />
          <div class="min-w-0">
            <p class="truncate text-sm">
              <span :class="mobile && 'font-medium'">{{ run.agentName }}</span> is {{ verb(run) }} <TaskLink
                v-if="run.taskRef"
                :task-ref="run.taskRef"
                class="relative z-10"
              /><template v-else>
                {{ run.epicId ? 'task' : '' }}
              </template> {{ taskOf(run)?.title ?? run.epicTitle ?? '' }}
            </p>
            <p class="text-xs text-muted-foreground">
              Run #{{ run.number }} · <ElapsedTime :from="run.startedAt ?? run.queuedAt" /> · {{ run.state.replace('_', ' ') }}
            </p>
          </div>
          <NuxtLink
            :to="runPath(run.agentName, run.id)"
            :aria-label="`${run.agentName}, run #${run.number}`"
            :class="['absolute inset-0 rounded-lg', !mobile && 'outline-primary']"
          />
        </div>
      </BorderGlow>
    </div>
    <p
      v-else
      class="text-sm text-muted-foreground"
    >
      No agent is working on this project right now.
    </p>
  </section>
</template>
