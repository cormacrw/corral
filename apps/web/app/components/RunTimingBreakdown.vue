<script setup lang="ts">
import type { Run, RunPhase } from '@corral/contracts'

const props = defineProps<{ run: Run }>()
const labels: Record<RunPhase, string> = {
  worktree_prepare: 'Worktree preparation', session_setup: 'Session setup',
  design_save: 'Design save', agent_cold_start: 'Agent cold start',
  agent_resume: 'Agent resume', agent_warm_turn: 'Agent warm turn',
  design_pack: 'Design pack', push: 'Push', finish: 'Finish', other: 'Other'
}
const colors = ['bg-primary', 'bg-info', 'bg-success', 'bg-warning', 'bg-error']
const phases = computed(() => [...(props.run.timings?.phases ?? [])]
  .sort((a, b) => b.durationMs - a.durationMs)
  .map((phase, index) => ({ ...phase, label: labels[phase.phase], color: colors[index % colors.length] })))
const tools = computed(() => [...(props.run.timings?.tools ?? [])].sort((a, b) => b.totalMs - a.totalMs))
// startedAt is recorded after worktree/session preparation. The API has no
// assignment timestamp, so label this queue-to-start interval explicitly.
const queueMs = computed(() => props.run.startedAt
  ? Math.max(0, Date.parse(props.run.startedAt) - Date.parse(props.run.queuedAt))
  : null)
function time(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
</script>

<template>
  <section
    v-if="run.timings"
    aria-label="Run timing breakdown"
    class="rounded-lg border border-default p-3 text-sm"
  >
    <h2 class="font-semibold text-highlighted">
      Run timing breakdown
    </h2>
    <p class="mt-1 text-xs text-muted">
      Queue wait (queued to started, including preparation): {{ queueMs === null ? 'Unavailable' : time(queueMs) }}
    </p>
    <p class="mt-2 text-xs text-muted">
      Run phases · {{ time(run.timings.totalMs) }} total · slowest first
    </p>
    <div
      class="mt-2 flex h-3 overflow-hidden rounded-full bg-elevated"
      role="img"
      :aria-label="phases.map(p => `${p.label}: ${time(p.durationMs)}`).join(', ') || 'No recorded phases'"
    >
      <span
        v-for="phase in phases"
        :key="phase.phase"
        :class="[phase.color, 'h-full']"
        :style="{ width: `${run.timings.totalMs > 0 ? phase.durationMs / run.timings.totalMs * 100 : 0}%` }"
        :title="`${phase.label}: ${time(phase.durationMs)}`"
      />
    </div>
    <table class="mt-2 w-full text-xs">
      <caption class="sr-only">
        Run phases, slowest first
      </caption>
      <thead class="text-muted">
        <tr>
          <th
            scope="col"
            class="py-1 text-start font-normal"
          >
            Phase
          </th>
          <th
            scope="col"
            class="text-end font-normal"
          >
            Duration
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(phase, index) in phases"
          :key="phase.phase"
          :class="index === 0 ? 'bg-elevated font-semibold text-highlighted' : ''"
        >
          <th
            scope="row"
            class="py-1 text-start font-normal"
          >
            <span
              :class="[phase.color, 'me-2 inline-block size-2 rounded-full']"
              aria-hidden="true"
            />{{ phase.label }}<span
              v-if="index === 0"
              class="ms-1 text-muted"
            >· largest</span>
          </th>
          <td class="text-end tabular-nums">
            {{ time(phase.durationMs) }}
          </td>
        </tr>
      </tbody>
    </table>
    <table
      v-if="tools.length"
      class="mt-3 w-full table-fixed text-xs"
    >
      <caption class="mb-1 text-start font-medium">
        Tools · slowest total first
      </caption>
      <thead class="text-muted">
        <tr>
          <th
            scope="col"
            class="w-[46%] py-1 text-start font-normal"
          >
            Tool
          </th>
          <th
            scope="col"
            class="text-end font-normal"
          >
            Count
          </th>
          <th
            scope="col"
            class="text-end font-normal"
          >
            Total
          </th>
          <th
            scope="col"
            class="text-end font-normal"
          >
            Max
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="tool in tools"
          :key="tool.tool"
          class="border-t border-default"
        >
          <th
            scope="row"
            class="py-1 pe-2 text-start font-mono font-normal wrap-anywhere"
          >
            {{ tool.tool }}
          </th>
          <td class="text-end tabular-nums">
            {{ tool.count }}
          </td>
          <td class="text-end tabular-nums">
            {{ time(tool.totalMs) }}
          </td>
          <td class="text-end tabular-nums">
            {{ time(tool.maxMs) }}
          </td>
        </tr>
      </tbody>
    </table>
    <p
      v-else
      class="mt-3 text-xs text-muted"
    >
      No recorded tool calls.
    </p>
    <p class="mt-2 text-xs text-muted">
      Tool calls can overlap; their totals are separate from run phases.
    </p>
  </section>
</template>
