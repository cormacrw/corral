<script setup lang="ts">
import { ROLE_LABELS } from '@corral/core'
import type { AgentSettings } from '~/features/settings/composables/useAgentSettings'
import { agentLimit } from '~/features/agents/utils/agents'
import { runtimeLabel } from '~/utils/labels'

const props = defineProps<{ settings: AgentSettings }>()
defineEmits<{ add: [] }>()
const { agents, patchAgent, saveAvatar } = props.settings
</script>

<template>
  <AppCard>
    <template #header>
      <div class="flex items-start gap-3">
        <div class="flex-1">
          <h2 class="font-medium">
            Agents
          </h2>
          <p class="text-xs text-muted-foreground">
            Shared by every project. Each runs through your local CLI login; Corral never sees your credentials.
          </p>
        </div>
        <AppButton
          label="Add agent"
          icon="i-hugeicons-add-01"
          size="sm"
          data-testid="add-agent"
          @click="$emit('add')"
        />
      </div>
    </template>
    <ul class="divide-y divide-border">
      <li
        v-for="agent in agents"
        :key="agent.id"
        class="flex flex-wrap items-center gap-3 py-3"
      >
        <div class="min-w-0 flex-1 basis-48">
          <div class="flex items-center gap-2">
            <span class="font-medium">{{ agent.name }}</span>
            <AppBadge
              :label="ROLE_LABELS[agent.role]"
              color="primary"
              variant="subtle"
              size="xs"
            />
          </div>
          <p class="text-xs text-muted-foreground">
            <span data-testid="agent-runtime-label">{{ runtimeLabel(agent.runtime) }}</span> · {{ agentLimit(agent) }} · <span class="font-mono">.corral/agents/{{ agent.role }}.md</span>
          </p>
          <AvatarUpload
            :name="agent.name"
            :avatar-url="agent.avatarUrl"
            size="lg"
            class="mt-2"
            :save="(image: Blob) => saveAvatar(agent, image)"
            :remove="() => saveAvatar(agent, null)"
          />
        </div>
        <SettingsAgentFields
          :agent="agent"
          :settings="settings"
          compact
        >
          <template #after-runtime>
            <ConcurrencyField
              v-if="agent.role !== 'pm'"
              :agent="agent"
            />
          </template>
        </SettingsAgentFields>
        <AppFormField label="Paused">
          <AppSwitch
            :model-value="agent.paused"
            :aria-label="`Pause ${agent.name}`"
            @update:model-value="patchAgent(agent, { paused: $event })"
          />
        </AppFormField>
      </li>
    </ul>
  </AppCard>
</template>
