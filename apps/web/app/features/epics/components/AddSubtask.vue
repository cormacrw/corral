<script setup lang="ts">
import { errorText } from '@corral/core'
import { useMutation } from '@tanstack/vue-query'
import { addSubtask } from '~/queries/tasks'

// Adds a sub-task by title. On a task nobody has started, the first one makes
// it a parent: its criteria move to the new sub-task (D31).
const props = defineProps<{ slug: string, number: number, promotes?: boolean }>()
const add = useMutation(addSubtask)
const toast = useToast()
const open = ref(false)
const title = ref('')

async function submit() {
  const text = title.value.trim()
  if (!text) return
  try {
    await add.mutateAsync({ slug: props.slug, number: props.number, input: { title: text, type: 'task' } })
    title.value = ''
    open.value = false
  } catch (e) {
    toast.add({ title: 'Could not add the subtask', description: errorText(e), color: 'error' })
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <AppButton
      v-if="!open"
      label="Add subtask"
      icon="i-hugeicons-play-list-add"
      size="sm"
      variant="outline"
      color="neutral"
      @click="open = true"
    />
    <form
      v-else
      class="flex min-w-0 flex-1 items-center gap-2"
      @submit.prevent="submit"
    >
      <AppInput
        v-model="title"
        autofocus
        size="sm"
        placeholder="Subtask title"
        aria-label="Subtask title"
        class="min-w-0 flex-1"
      />
      <AppButton
        type="submit"
        label="Add"
        size="sm"
        :loading="add.isPending.value"
      />
      <AppButton
        label="Cancel"
        size="sm"
        variant="ghost"
        color="neutral"
        @click="open = false"
      />
    </form>
    <p
      v-if="open && props.promotes"
      class="w-full text-xs text-muted-foreground"
    >
      This task gets its first subtask. Its criteria move to the new subtask.
    </p>
  </div>
</template>
