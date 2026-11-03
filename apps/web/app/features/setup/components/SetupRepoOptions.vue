<script setup lang="ts">
import type { Setup } from '~/features/setup/composables/useSetup'

const MERGE_METHODS = [{ label: 'Squash and merge', value: 'squash' }, { label: 'Merge commit', value: 'merge' }, { label: 'Rebase and merge', value: 'rebase' }]

const props = defineProps<{ setup: Setup }>()
const { prefix, prefixError, setPrefix, checking, defaultBranch, mergeMethod } = props.setup
const { isMobile } = useDevice()
</script>

<template>
  <AppFormField
    v-slot="{ id }"
    label="Task ID prefix"
    :error="prefixError"
    :help="`Task IDs: ${prefix || '…'}-1`"
    required
  >
    <AppInput
      :id="id"
      :model-value="prefix"
      :size="isMobile ? 'lg' : 'md'"
      :disabled="checking"
      class="w-full font-mono"
      @update:model-value="setPrefix(String($event))"
    />
  </AppFormField>
  <div class="grid gap-3 sm:grid-cols-2">
    <AppFormField
      v-slot="{ id }"
      label="Default branch"
      help="From GitHub. Agents branch from it and merge back into it."
    >
      <AppInput
        :id="id"
        v-model="defaultBranch"
        :size="isMobile ? 'lg' : 'md'"
        class="w-full font-mono"
      />
    </AppFormField>
    <AppFormField
      v-slot="{ id }"
      label="Merge method"
    >
      <AppSelectMenu
        :id="id"
        v-model="mergeMethod"
        :items="MERGE_METHODS"
      />
    </AppFormField>
  </div>
</template>
