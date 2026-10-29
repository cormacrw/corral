<script setup lang="ts">
import type { Run } from '@corral/contracts'
import type { AgentRuns } from '~/composables/useAgentRuns'
import { timeAgo } from '~/utils/labels'
import { runComposer } from '~/utils/run-composer'

// Under a run's transcript on the agent page, web and mobile
// (design/agent.md): the composer while a developer or reviewer run is live,
// disabled with the reason when the message can't reach the agent (a Codex
// run, the runner offline), and the read-only note once the run finished.
const props = defineProps<{ view: AgentRuns, run: Run }>()
const { agent, now, runnerOnline, message, project } = props.view

const state = computed(() => agent.value ? runComposer(props.run, agent.value, runnerOnline.value) : { kind: 'read-only' as const })
const draft = ref('')
const busy = ref(false)

async function send(text: string): Promise<boolean> {
  busy.value = true
  try {
    const ok = await message(props.run, text)
    if (ok) draft.value = ''
    return ok
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    v-if="state.kind === 'open' || state.kind === 'disabled'"
    class="mx-auto flex w-full max-w-[880px] flex-col gap-1.5"
  >
    <PromptComposer
      v-model="draft"
      :placeholder="state.kind === 'open' ? `Message ${agent?.name} mid-run…` : 'Messages are off for this run'"
      :hint="state.kind === 'open' ? `${agent?.name} reads this at its next step` : ''"
      :disabled="state.kind === 'disabled'"
      :busy="busy"
      :project="state.kind === 'open' ? project(props.run)?.slug ?? null : null"
      data-testid="run-composer"
      @submit="send"
    />
    <p
      v-if="state.kind === 'disabled'"
      class="flex items-start gap-1.5 text-xs text-muted"
      data-testid="run-composer-reason"
    >
      <UIcon
        name="i-lucide-info"
        class="mt-0.5 size-3 shrink-0"
      />
      {{ state.reason }}
    </p>
  </div>
  <p
    v-else-if="state.kind === 'plan'"
    class="text-xs text-muted"
  >
    Live. {{ agent?.name }} runs a turn for each message you send in Plan; reply to it there.
  </p>
  <p
    v-else
    class="text-xs text-muted"
  >
    <UIcon
      name="i-lucide-lock"
      class="size-3"
    /> Read-only. This run finished {{ timeAgo(props.run.endedAt, now) }}. To change the work, comment on the task.
  </p>
</template>
