<script setup lang="ts">
import { runnerRoles, runnerState, runtimeLabel, timeAgo } from '~/utils/labels'

// Every runner the server knows (design/settings.md, Runner): its state,
// slots in use, runtimes and roles. Offline runners stay listed, and one
// turned away for an old protocol shows the version the server expects.
const state = useLive().state
const runners = computed(() => state.value.runner?.runners ?? [])
const expected = computed(() => state.value.runner?.protocol)
</script>

<template>
  <div
    class="flex flex-col divide-y divide-default"
    data-testid="runner-list"
  >
    <p
      v-if="!runners.length"
      class="py-2 text-sm text-muted"
    >
      Offline · no runner yet
    </p>
    <div
      v-for="runner in runners"
      :key="runner.id"
      class="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
      data-testid="runner-row"
    >
      <UIcon
        name="i-lucide-server"
        class="mt-0.5 size-5 shrink-0 text-muted"
      />
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-highlighted">{{ runner.name }}</span>
          <UBadge
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
          class="text-xs text-muted"
          data-testid="runner-slots"
        >
          {{ runner.online ? `${runner.slotsInUse} of ${runner.slots} slots in use` : `${runner.slots} ${runner.slots === 1 ? 'slot' : 'slots'}` }}
          · {{ runner.runtimes.map(runtimeLabel).join(', ') || 'no signed-in CLI' }}
          · {{ runnerRoles(runner.roles) || 'no roles' }}
        </p>
        <p
          class="text-xs text-muted"
          data-testid="runner-slot-source"
        >
          <template v-if="runner.slotSource?.kind === 'derived'">
            Derived from {{ Number(runner.slotSource.cpus.toFixed(2)) }} CPUs and {{ Number((runner.slotSource.memoryBytes / 1024 ** 3).toFixed(2)) }} GiB memory
            · {{ runner.slotSource.slotCpus }} CPUs / {{ Number((runner.slotSource.slotMemoryBytes / 1024 ** 3).toFixed(2)) }} GiB per slot
          </template>
          <template v-else-if="runner.slotSource?.kind === 'explicit'">
            Set explicitly by CORRAL_RUNNER_SLOTS
          </template>
          <template v-else>
            Slot source unavailable · update runner to report resources
          </template>
        </p>
        <p class="text-xs text-muted">
          {{ runner.needsUpdate ? 'Turned away' : 'Last heartbeat' }} {{ timeAgo(runner.lastHeartbeatAt) }}
        </p>
        <RunnerUpdate
          v-if="!runner.needsUpdate || runner.behind"
          :runner="runner"
        />
      </div>
    </div>
  </div>
</template>
