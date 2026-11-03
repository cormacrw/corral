<script setup lang="ts">
import type { Project } from '@corral/contracts'
import type { ProjectSettings } from '~/features/projects/composables/useProjectSettings'

const props = defineProps<{ project: Project, settings: ProjectSettings }>()
const { form, setPaused } = props.settings
</script>

<template>
  <ProjectSettingsSection title="Automation">
    <ProjectSettingsRow
      label="Pause project"
      hint="No new runs start; work already running finishes. Applies immediately."
    >
      <AppSwitch
        :model-value="project.paused"
        aria-label="Pause project"
        @update:model-value="setPaused"
      />
    </ProjectSettingsRow>
    <ProjectSettingsRow
      label="Human review for new tasks"
      hint="The default for each task's flag (D5)"
    >
      <AppSwitch
        v-model="form.humanReviewDefault"
        aria-label="Human review for new tasks"
      />
    </ProjectSettingsRow>
    <ProjectSettingsRow
      label="Limits"
      hint="Hitting a limit makes the task Blocked or Failed"
    >
      <div class="flex gap-3">
        <AppFormField
          v-slot="{ id }"
          label="Review rounds"
        >
          <AppNumberInput
            :id="id"
            v-model="form.reviewRoundCap"
            :min="1"
          />
        </AppFormField>
        <AppFormField
          v-slot="{ id }"
          label="Failed runs"
        >
          <AppNumberInput
            :id="id"
            v-model="form.failedRunCap"
            :min="1"
          />
        </AppFormField>
      </div>
    </ProjectSettingsRow>
  </ProjectSettingsSection>
</template>
