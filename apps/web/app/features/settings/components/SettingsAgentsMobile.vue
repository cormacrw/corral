<script setup lang="ts">
import { ROLE_LABELS } from '@corral/core'
import type { AgentSettings } from '~/features/settings/composables/useAgentSettings'
import { runtimeLabel } from '~/utils/labels'

const props = defineProps<{ settings: AgentSettings }>()
const { agents, patchAgent, saveAvatar } = props.settings
const route = useRoute()
// Also wait for the live agents on a direct navigation before finding the anchor.
watch([() => route.hash, () => agents.value?.map(agent => agent.id).join(',')], async () => {
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
      class="flex min-w-0 scroll-mt-4 flex-col gap-4 rounded-lg border border-border p-4"
      :aria-label="agent.name"
    >
      <div class="flex min-w-0 items-center gap-3">
        <AgentAvatar
          :src="agent.avatarUrl"
          :name="agent.name"
          size="lg"
        />
        <div class="min-w-0 flex-1">
          <h2 class="truncate font-semibold text-foreground">
            {{ agent.name }}
          </h2>
          <div class="flex flex-wrap items-center gap-2">
            <AppBadge
              :label="ROLE_LABELS[agent.role]"
              variant="subtle"
              size="sm"
            />
            <span class="text-sm text-muted-foreground">{{ runtimeLabel(agent.runtime) }}</span>
            <AppBadge
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
        class="font-medium text-foreground"
      >
        One turn per Plan session
      </p>
      <div
        v-else
        class="flex flex-col gap-2"
      >
        <h3 class="font-medium text-foreground">
          Concurrency
        </h3>
        <ConcurrencyStepper
          :agent="agent"
          full-width
          class="w-full"
        />
      </div>
      <AppSwitch
        :model-value="agent.paused"
        label="Paused"
        :aria-label="`Pause ${agent.name}`"
        class="min-h-11 w-full flex-row-reverse justify-between gap-0"
        label-class="flex min-h-11 flex-1 items-center"
        switch-class="relative after:absolute after:inset-x-0 after:-inset-y-3"
        @update:model-value="patchAgent(agent, { paused: $event })"
      />
      <details class="border-t border-border pt-2">
        <summary class="flex min-h-11 cursor-pointer items-center gap-2 font-medium text-foreground">
          <Icon
            name="i-hugeicons-settings-02"
            class="size-4"
          />More settings
        </summary>
        <div class="flex min-w-0 flex-col gap-4 pt-3">
          <SettingsAgentFields
            :agent="agent"
            :settings="settings"
          />
          <AppFormField label="Picture">
            <AvatarUpload
              :name="agent.name"
              :avatar-url="agent.avatarUrl"
              :save="(image: Blob) => saveAvatar(agent, image)"
              :remove="() => saveAvatar(agent, null)"
            />
          </AppFormField>
        </div>
      </details>
    </section>
    <SettingsKillSwitch :settings="settings" />
  </div>
</template>
