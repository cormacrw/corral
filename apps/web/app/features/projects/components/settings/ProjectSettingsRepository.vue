<script setup lang="ts">
import type { Project } from '@corral/contracts'
import type { ProjectSettings } from '~/features/projects/composables/useProjectSettings'
import { EPIC_REVIEW_MODE } from '~/utils/labels'

const props = defineProps<{ project: Project, settings: ProjectSettings }>()
const { form } = props.settings
const epicReviewModes = Object.entries(EPIC_REVIEW_MODE).map(([value, mode]) => ({ value, label: mode.label, description: mode.description }))
const MERGE_METHODS = [{ label: 'Squash and merge', value: 'squash' }, { label: 'Merge commit', value: 'merge' }, { label: 'Rebase and merge', value: 'rebase' }]
const CHECK_CHOICES = ['lint', 'typecheck', 'test', 'build']

const checks = computed(() => [...new Set([...CHECK_CHOICES, ...form.requiredChecks])])
const toggleCheck = (name: string) => {
  form.requiredChecks = form.requiredChecks.includes(name) ? form.requiredChecks.filter(c => c !== name) : [...form.requiredChecks, name]
}
const customCheck = ref('')
function addCustomCheck() {
  const name = customCheck.value.trim()
  if (!name) return
  toggleCheck(name)
  customCheck.value = ''
}
</script>

<template>
  <ProjectSettingsSection title="Repository">
    <div class="flex items-center gap-2 rounded-md bg-muted/50 p-3 text-sm">
      <Icon
        name="i-hugeicons-git-branch"
        class="size-4 text-muted-foreground"
      />
      <span class="font-mono">github.com/{{ project.repository }}</span>
      <span class="ms-auto text-xs text-muted-foreground">Cloned on the runner</span>
    </div>
    <ProjectSettingsRow
      label="Default branch"
      hint="Agents branch from here and merge back into it."
      for="branch"
    >
      <AppInput
        id="branch"
        v-model="form.defaultBranch"
      />
    </ProjectSettingsRow>
    <ProjectSettingsRow
      label="Subtask review mode"
      :hint="`For new tasks with subtasks a plan doesn't set a mode for. ${EPIC_REVIEW_MODE[form.epicReviewModeDefault].description}.`"
      for="epic-review-mode"
    >
      <AppSelectMenu
        id="epic-review-mode"
        v-model="form.epicReviewModeDefault"
        :items="epicReviewModes"
      />
    </ProjectSettingsRow>
    <ProjectSettingsRow label="Merge method">
      <AppSelectMenu
        v-model="form.mergeMethod"
        :items="MERGE_METHODS"
      />
    </ProjectSettingsRow>
    <ProjectSettingsRow
      label="Required checks"
      hint="GitHub check names that must pass. With no checks, unflagged tasks merge on the reviewer's approval alone."
    >
      <div class="flex flex-wrap gap-1.5">
        <AppButton
          v-for="name in checks"
          :key="name"
          :label="name"
          size="xs"
          :variant="form.requiredChecks.includes(name) ? 'subtle' : 'outline'"
          :color="form.requiredChecks.includes(name) ? 'primary' : 'neutral'"
          :aria-pressed="form.requiredChecks.includes(name)"
          @click="toggleCheck(name)"
        />
        <form
          class="flex gap-1"
          @submit.prevent="addCustomCheck"
        >
          <AppInput
            v-model="customCheck"
            placeholder="Other check name"
            size="xs"
          />
        </form>
      </div>
    </ProjectSettingsRow>
  </ProjectSettingsSection>
</template>
