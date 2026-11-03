<script setup lang="ts">
// Project settings (design/project-settings.md). On mobile the sections stack
// under the mobile header, which holds Save (design/mobile.md).
const device = useDevice()
const { project } = useProject()
const settings = useProjectSettings()
</script>

<template>
  <AppPanel>
    <MobilePageHeader v-if="device.isMobile.value">
      <template #actions>
        <ProjectSettingsSave
          :settings="settings"
          label="Save"
        />
      </template>
    </MobilePageHeader>
    <div
      v-if="project"
      :class="['mx-auto flex w-full max-w-[880px] flex-col gap-6', device.isMobile.value ? 'p-4' : 'p-6']"
    >
      <p
        v-if="device.isMobile.value"
        class="text-sm text-muted-foreground"
      >
        Settings for {{ project.name }} only. Agents and the runner are shared by every project and live in Settings.
      </p>
      <header
        v-else
        class="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background py-3"
      >
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-semibold">
            Project settings
          </h1>
          <p class="text-sm text-muted-foreground">
            Settings for {{ project.name }} only. Agents and the runner are shared by every project and live in Settings.
          </p>
        </div>
        <ProjectSettingsSave
          :settings="settings"
          label="Save changes"
        />
      </header>

      <ProjectSettingsGeneral
        :project="project"
        :settings="settings"
      />
      <ProjectSettingsRepository
        :project="project"
        :settings="settings"
      />
      <ProjectSettingsAutomation
        :project="project"
        :settings="settings"
      />
      <ProjectSettingsDangerZone :project="project" />
    </div>
  </AppPanel>
</template>
