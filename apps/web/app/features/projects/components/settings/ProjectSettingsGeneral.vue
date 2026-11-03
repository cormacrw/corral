<script setup lang="ts">
import type { Project } from '@corral/contracts'
import type { ProjectSettings } from '~/features/projects/composables/useProjectSettings'

const props = defineProps<{ project: Project, settings: ProjectSettings }>()
const { form, prefixError } = props.settings
</script>

<template>
  <ProjectSettingsSection title="General">
    <ProjectSettingsRow
      label="Name"
      hint="Required"
      for="name"
    >
      <AppInput
        id="name"
        v-model="form.name"
      />
    </ProjectSettingsRow>
    <ProjectSettingsRow
      label="Thumbnail"
      hint="Shown in the sidebar and overview"
    >
      <ProjectThumbnailPicker
        :project="project"
        :settings="settings"
      />
    </ProjectSettingsRow>
    <ProjectSettingsRow
      label="Task ID prefix"
      :hint="`Next task: ${form.prefix || project.prefix}-${project.nextTaskNumber}. Existing tasks keep their numbers.`"
      for="prefix"
    >
      <AppFormField :error="prefixError">
        <AppInput
          id="prefix"
          :model-value="form.prefix"
          class="font-mono"
          maxlength="5"
          :aria-invalid="Boolean(prefixError) || undefined"
          @update:model-value="form.prefix = String($event).toUpperCase().replace(/[^A-Z]/g, '')"
        />
      </AppFormField>
    </ProjectSettingsRow>
  </ProjectSettingsSection>
</template>
