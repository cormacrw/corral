<script setup lang="ts">
import type { ProjectSettings } from '~/features/projects/composables/useProjectSettings'

const props = defineProps<{ settings: ProjectSettings, label: string }>()
const { canSave, saving, saved, save } = props.settings
</script>

<template>
  <span
    v-if="saved"
    class="text-xs text-success"
  >Saved</span>
  <AppButton
    :label="label"
    :disabled="!canSave"
    :loading="saving"
    @click="save"
  />
</template>
