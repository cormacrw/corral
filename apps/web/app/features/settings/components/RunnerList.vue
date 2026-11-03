<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { runnerQuery } from '~/queries/system'
import { runnerRoles, runnerState, runtimeLabel } from '~/utils/labels'
import { runnerSlots, runnerSlotSource } from '~/features/settings/utils/runner'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// Every runner the server knows (design/settings.md, Runner): its state,
// slots in use, runtimes and roles. Offline runners stay listed, and one
// turned away for an old protocol shows the version the server expects.
const { data: status } = useQuery(runnerQuery())
const runners = computed(() => status.value?.runners ?? [])
const expected = computed(() => status.value?.protocol)
</script>

<template>
  <div
    class="flex flex-col divide-y divide-border"
    data-testid="runner-list"
  >
    <p
      v-if="!runners.length"
      class="py-2 text-sm text-muted-foreground"
    >
      Offline · no runner yet
    </p>
    <div
      v-for="runner in runners"
      :key="runner.id"
      class="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
      data-testid="runner-row"
    >
      <Icon
        name="i-ri-server-line"
        class="mt-0.5 size-5 shrink-0 text-muted-foreground"
      />
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-foreground">{{ runner.name }}</span>
          <AppBadge
            :label="runnerState(runner).label"
            :color="runnerState(runner).color"
            variant="subtle"
            size="sm"
            data-testid="runner-state"
          />
        </p>
        <p
          v-if="runner.needsUpdate"
          class="text-xs text-warning"
        >
          Speaks protocol {{ runner.protocol }}; this server expects protocol {{ expected }}. Update the runner to reconnect.
        </p>
        <p
          v-else
          class="text-xs text-muted-foreground"
          data-testid="runner-slots"
        >
          {{ runnerSlots(runner) }}
          · {{ runner.runtimes.map(runtimeLabel).join(', ') || 'no signed-in CLI' }}
          · {{ runnerRoles(runner.roles) || 'no roles' }}
        </p>
        <p
          class="text-xs text-muted-foreground"
          data-testid="runner-slot-source"
        >
          {{ runnerSlotSource(runner) }}
        </p>
        <p class="text-xs text-muted-foreground">
          {{ runner.needsUpdate ? 'Turned away' : 'Last heartbeat' }} <TimeAgo :at="runner.lastHeartbeatAt" />
        </p>
        <RunnerUpdate
          v-if="!runner.needsUpdate || runner.behind"
          :runner="runner"
        />
      </div>
    </div>
  </div>
</template>
