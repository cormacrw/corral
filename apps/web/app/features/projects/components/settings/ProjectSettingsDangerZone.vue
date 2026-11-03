<script setup lang="ts">
import type { Project } from '@corral/contracts'

const props = defineProps<{ project: Project }>()
const { open, confirm, confirmed, removing, ask, remove } = useProjectRemoval(() => props.project)
</script>

<template>
  <ProjectSettingsSection
    title="Danger zone"
    danger
  >
    <ProjectSettingsRow
      label="Remove project"
      hint="Stops every run and removes the project from Corral. Your repository, branches and PRs on GitHub are left alone."
    >
      <AppButton
        :label="`Remove ${project.name}`"
        color="error"
        variant="outline"
        @click="ask"
      />
    </ProjectSettingsRow>
  </ProjectSettingsSection>
  <AppModal
    v-model:open="open"
    :title="`Remove ${project.name}?`"
    description="Stops every run and removes the project with its tasks, parent tasks and plans from Corral. Your repository, branches and PRs on GitHub are left alone."
  >
    <template #body>
      <form
        id="remove-project"
        @submit.prevent="remove"
      >
        <AppFormField
          v-slot="{ id }"
          :label="`Type ${project.name} to confirm`"
        >
          <AppInput
            :id="id"
            v-model="confirm"
            autocomplete="off"
          />
        </AppFormField>
      </form>
    </template>
    <template #footer>
      <AppButton
        label="Cancel"
        variant="outline"
        color="neutral"
        @click="open = false"
      />
      <AppButton
        type="submit"
        form="remove-project"
        :label="`Remove ${project.name}`"
        color="error"
        :disabled="!confirmed"
        :loading="Boolean(removing)"
      />
    </template>
  </AppModal>
</template>
