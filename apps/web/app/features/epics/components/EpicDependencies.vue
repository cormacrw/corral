<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
import type { Epic } from '@corral/contracts'
import { useMutation } from '@tanstack/vue-query'
import { setEpicDependencies } from '~/queries/epics'

// The epics this one waits on, which can be edited, and those waiting on it
const props = defineProps<{
  epicId: string
  dependsOn: string[]
  prerequisites: Epic[]
  blocked: Epic[]
  choices: { label: string, value: string }[]
}>()
const dependencies = useMutation(setEpicDependencies)
const selected = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

async function setDependencies(ids: string[]) {
  if (saving.value) return
  saving.value = true
  error.value = null
  try {
    await dependencies.mutateAsync({ id: props.epicId, dependsOn: ids })
    selected.value = ''
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="space-y-3">
    <h3 class="text-sm font-medium">
      Depends on
    </h3>
    <p
      v-if="!prerequisites.length"
      class="text-sm text-muted-foreground"
    >
      No dependencies.
    </p>
    <div
      v-for="item in prerequisites"
      :key="item.id"
      class="flex items-center gap-2"
    >
      <NuxtLink
        :to="`/epics/${item.id}`"
        class="min-w-0 flex-1 text-sm text-brand hover:underline"
      >
        {{ item.title }} · {{ item.mergedCount }}/{{ item.taskCount }} done
      </NuxtLink>
      <AppButton
        icon="i-hugeicons-cancel-01"
        color="neutral"
        variant="ghost"
        :aria-label="`Remove dependency on ${item.title}`"
        :disabled="saving"
        @click="setDependencies(dependsOn.filter(id => id !== item.id))"
      />
    </div>
    <div class="flex gap-2">
      <AppSelect
        v-model="selected"
        :items="choices"
        placeholder="Choose a task"
        aria-label="Dependency task"
        class="min-w-0 flex-1"
        :disabled="saving"
      />
      <AppButton
        label="Add"
        :disabled="!selected || saving"
        @click="setDependencies([...dependsOn, selected])"
      />
    </div>
    <AppAlert
      v-if="error"
      color="error"
      :title="error"
    />
    <h3 class="text-sm font-medium">
      Blocks
    </h3>
    <p
      v-if="!blocked.length"
      class="text-sm text-muted-foreground"
    >
      Nothing waits on this.
    </p>
    <NuxtLink
      v-for="item in blocked"
      :key="item.id"
      :to="`/epics/${item.id}`"
      class="block text-sm text-brand hover:underline"
    >
      {{ item.title }} · {{ item.mergedCount }}/{{ item.taskCount }} done
    </NuxtLink>
  </section>
</template>
