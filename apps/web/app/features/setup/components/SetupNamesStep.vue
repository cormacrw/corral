<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'
import { initials } from '~/utils/labels'

const ROLES = [
  { role: 'pm', label: 'PM', description: 'Plans work with you and proposes tasks.' },
  { role: 'developer', label: 'Developer', description: 'Implements tasks and opens PRs with evidence.' },
  { role: 'reviewer', label: 'Reviewer', description: 'Verifies changes against the acceptance criteria.' }
] as const
const RUNTIMES = [{ label: 'Claude', value: 'claude' }]

const props = defineProps<{ setup: Setup }>()
const { agentNames, suggest } = props.setup
const { isMobile } = useDevice()
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-2">
      <div>
        <p class="font-medium">
          Agent roles
        </p>
        <p class="text-xs text-muted-foreground">
          All three run on Claude for now. Add Codex agents later in Settings.
        </p>
      </div>
      <AppButton
        label="Suggest names"
        :size="isMobile ? 'md' : 'xs'"
        variant="ghost"
        color="neutral"
        icon="i-ri-sparkling-2-line"
        @click="suggest"
      />
    </div>
    <ul class="flex flex-col gap-3">
      <li
        v-for="r in ROLES"
        :key="r.role"
        :class="['flex gap-3 rounded-lg border border-border p-3', isMobile ? 'flex-col' : 'items-center']"
      >
        <div class="flex min-w-0 flex-1 items-center gap-3">
          <AppAvatar
            :text="initials(agentNames[r.role] || r.label)"
            :size="isMobile ? 'lg' : 'md'"
          />
          <div class="min-w-0 flex-1 text-sm">
            <div class="flex items-center gap-2">
              <span class="truncate font-medium">{{ agentNames[r.role] }}</span>
              <AppBadge
                :label="r.label"
                color="primary"
                variant="subtle"
                :size="isMobile ? 'sm' : 'xs'"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              {{ r.description }}
            </p>
          </div>
        </div>
        <div :class="isMobile ? 'grid grid-cols-2 gap-2' : 'flex items-center gap-3'">
          <AppFormField
            v-slot="{ id }"
            label="Name"
          >
            <AppInput
              :id="id"
              v-model="agentNames[r.role]"
              :size="isMobile ? 'lg' : 'xs'"
              :aria-label="`${r.label} name`"
            />
          </AppFormField>
          <AppFormField
            v-slot="{ id }"
            label="Runs on"
          >
            <AppSelectMenu
              :id="id"
              model-value="claude"
              :items="RUNTIMES"
            />
          </AppFormField>
        </div>
      </li>
    </ul>
  </div>
</template>
