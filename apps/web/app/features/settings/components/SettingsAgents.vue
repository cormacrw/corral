<script setup lang="ts">
const { isMobile } = useDevice()
const settings = useAgentSettings()
const { clis, cliError } = settings
const adding = ref(false)
</script>

<template>
  <div>
    <template v-if="isMobile">
      <MobilePageHeader>
        <template #actions>
          <AppButton
            label="Add agent"
            icon="i-ri-add-line"
            data-testid="add-agent"
            @click="adding = true"
          />
        </template>
      </MobilePageHeader>
      <SettingsAgentsMobile :settings="settings" />
    </template>
    <div
      v-else
      class="flex flex-col gap-6"
    >
      <SettingsAgentsDesktop
        :settings="settings"
        @add="adding = true"
      />
      <SettingsKillSwitch :settings="settings" />
    </div>
    <AgentForm
      v-model:open="adding"
      :clis="clis"
      :cli-error="cliError"
    />
  </div>
</template>
