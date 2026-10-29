<script setup lang="ts">
import type { Agent, AgentRuntime } from '@corral/contracts'
import type { api } from '~/composables/useApi'
import { ROLE, runtimeLabel } from '~/utils/labels'

const props = defineProps<{
  agents: Agent[]
  stopped: boolean
  runtimeItems: (agent: Agent) => { label: string, value: string }[]
  patchAgent: (agent: Agent, input: Parameters<typeof api.agents.patch>[1]) => Promise<void>
  patchWakeInterval: (agent: Agent, minutes: number | null | undefined) => void
  saveAvatar: (agent: Agent, image: Blob | null) => Promise<void>
}>()
const emit = defineEmits<{ stop: [], resume: [] }>()
const route = useRoute()
// Also wait for the live agents on a direct navigation before finding the anchor.
watch([() => route.hash, () => props.agents.map(agent => agent.id).join(',')], async () => {
  await nextTick()
  if (route.hash.startsWith('#agent-')) document.getElementById(route.hash.slice(1))?.scrollIntoView({ block: 'start' })
}, { immediate: true, flush: 'post' })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4 p-4 pb-8">
    <section
      v-for="agent in agents"
      :id="`agent-${agent.id}`"
      :key="agent.id"
      class="flex min-w-0 scroll-mt-4 flex-col gap-4 rounded-lg border border-default p-4"
      :aria-label="agent.name"
    >
      <div class="flex min-w-0 items-center gap-3">
        <AgentAvatar
          :src="agent.avatarUrl"
          :name="agent.name"
          size="lg"
        />
        <div class="min-w-0 flex-1">
          <h2 class="truncate font-semibold text-highlighted">
            {{ agent.name }}
          </h2>
          <div class="flex flex-wrap items-center gap-2">
            <UBadge
              :label="ROLE[agent.role]"
              variant="subtle"
              size="sm"
            />
            <span class="text-sm text-muted">{{ runtimeLabel(agent.runtime) }}</span>
            <UBadge
              v-if="agent.paused"
              label="Paused"
              color="neutral"
              variant="subtle"
            />
          </div>
        </div>
      </div>
      <p
        v-if="agent.role === 'pm'"
        class="font-medium text-highlighted"
      >
        One turn per Plan session
      </p>
      <div
        v-else
        class="flex flex-col gap-2"
      >
        <h3 class="font-medium text-highlighted">
          Concurrency
        </h3>
        <ConcurrencyStepper
          :agent="agent"
          full-width
          class="w-full"
        />
      </div>
      <USwitch
        :model-value="agent.paused"
        label="Paused"
        :aria-label="`Pause ${agent.name}`"
        class="min-h-11 w-full items-center"
        :ui="{ root: 'flex-row-reverse justify-between', wrapper: 'ms-0 me-3 flex-1', label: 'flex min-h-11 w-full items-center', base: 'relative after:absolute after:inset-x-0 after:-inset-y-3' }"
        @update:model-value="patchAgent(agent, { paused: $event })"
      />
      <details class="border-t border-default pt-2">
        <summary class="flex min-h-11 cursor-pointer items-center gap-2 font-medium text-highlighted">
          <UIcon
            name="i-lucide-settings-2"
            class="size-4"
          />More settings
        </summary>
        <div class="flex min-w-0 flex-col gap-4 pt-3">
          <UFormField label="Name">
            <UInput
              :model-value="agent.name"
              :maxlength="80"
              class="w-full"
              size="lg"
              @change="patchAgent(agent, { name: String(($event.target as HTMLInputElement).value).trim() })"
            />
          </UFormField>
          <UFormField
            v-if="agent.role !== 'pm'"
            label="Runtime"
            :help="agent.activeRuns > 0 ? 'Changes once its runs end' : undefined"
          >
            <USelectMenu
              :model-value="agent.runtime"
              :items="runtimeItems(agent)"
              value-key="value"
              :search-input="false"
              :disabled="agent.activeRuns > 0"
              class="w-full"
              size="lg"
              @update:model-value="$event !== agent.runtime && patchAgent(agent, { runtime: $event as AgentRuntime })"
            />
          </UFormField>
          <UFormField
            v-if="agent.role !== 'pm'"
            label="Wake interval (min)"
            help="Blank: every check"
          >
            <UInputNumber
              :model-value="agent.wakeIntervalSeconds === null ? null : agent.wakeIntervalSeconds / 60"
              :min="1"
              placeholder="None"
              :aria-label="`Wake interval for ${agent.name} in minutes`"
              class="w-full"
              size="lg"
              @update:model-value="patchWakeInterval(agent, $event)"
            />
          </UFormField>
          <UFormField label="Picture">
            <AvatarUpload
              :name="agent.name"
              :avatar-url="agent.avatarUrl"
              :save="(image: Blob) => saveAvatar(agent, image)"
              :remove="() => saveAvatar(agent, null)"
            />
          </UFormField>
        </div>
      </details>
    </section>
    <section class="flex flex-col gap-4 rounded-lg border border-error/40 p-4">
      <h2 class="font-medium text-error">
        Kill switch
      </h2>
      <p class="text-sm text-muted">
        Stops every live run and prevents new ones until you resume. Tasks keep their status and retry afterwards.
      </p>
      <UButton
        v-if="stopped"
        label="Resume everything"
        size="lg"
        block
        @click="emit('resume')"
      />
      <UButton
        v-else
        label="Stop everything"
        color="error"
        size="lg"
        block
        @click="emit('stop')"
      />
    </section>
  </div>
</template>
