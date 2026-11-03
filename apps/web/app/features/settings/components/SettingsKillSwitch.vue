<script setup lang="ts">
import type { AgentSettings } from '~/features/settings/composables/useAgentSettings'

const props = defineProps<{ settings: AgentSettings }>()
const { stopped, stopAll, resumeAll } = props.settings
const { isMobile } = useDevice()
</script>

<template>
  <AppCard class="ring-destructive/40">
    <template #header>
      <h2 class="font-medium text-destructive">
        Kill switch
      </h2>
    </template>
    <div :class="isMobile ? 'flex flex-col gap-4' : 'grid gap-2 sm:grid-cols-[1fr_auto]'">
      <div>
        <span
          v-if="!isMobile"
          class="font-medium"
        >Stop everything</span>
        <p :class="isMobile ? 'text-sm text-muted-foreground' : 'text-xs text-muted-foreground'">
          Stops every live run and prevents new ones until you resume. Tasks keep their status and retry afterwards.
        </p>
      </div>
      <AppButton
        v-if="stopped"
        label="Resume everything"
        :size="isMobile ? 'lg' : 'md'"
        :block="isMobile"
        @click="resumeAll"
      />
      <AppButton
        v-else
        label="Stop everything"
        color="error"
        :size="isMobile ? 'lg' : 'md'"
        :block="isMobile"
        @click="stopAll"
      />
    </div>
  </AppCard>
</template>
