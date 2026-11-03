<script setup lang="ts">
import type { AgentSettings } from '~/features/settings/composables/useAgentSettings'
import { agentLimit } from '~/features/agents/utils/agents'
import { ROLE, runtimeLabel } from '~/utils/labels'

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
          icon="i-ri-add-line"
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
              :label="ROLE[agent.role]"
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
            <AppFormField
              v-if="agent.role !== 'pm'"
              label="Concurrency"
            >
              <AppNumberInput
                :model-value="agent.concurrency"
                :min="1"
                class="w-28"
                @update:model-value="$event && patchAgent(agent, { concurrency: $event })"
              />
            </AppFormField>
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
