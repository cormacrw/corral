<script setup lang="ts">
import type { EpicSync } from '@corral/contracts'
import { useMutation } from '@tanstack/vue-query'
import { retryEpicSync } from '~/queries/epics'
import { EPIC_CONFLICT_PENDING, epicStoppedLabel } from '~/utils/labels'

// What's holding an epic back: other epics it waits on, and its branch's state
const props = defineProps<{ epicId: string, waiting: { title: string }[], sync: EpicSync | null }>()
const toast = useToast()
const retry = useMutation(retryEpicSync)
const fileList = (files: string[]) => files.length ? `: ${files.join(', ')}` : ''
async function retrySync() {
  try {
    await retry.mutateAsync({ id: props.epicId })
  } catch (e) {
    toast.add({ title: 'Could not retry', description: e instanceof Error ? e.message : undefined, color: 'error' })
  }
}
</script>

<template>
  <AppAlert
    v-if="waiting.length"
    class="shrink-0"
    color="warning"
    variant="subtle"
    :title="`Waiting on ${waiting.map(e => e.title).join(', ')}`"
  />
  <AppAlert
    v-if="sync?.state === 'resolving'"
    class="shrink-0"
    color="info"
    variant="subtle"
    title="Resolving a rebase conflict"
    :description="`${sync.taskRef ?? 'A developer'} is rebasing this task in private${fileList(sync.files)}. The task's branch moves once a reviewer approves.`"
  />
  <AppAlert
    v-else-if="sync?.state === 'conflict_pending'"
    class="shrink-0"
    color="neutral"
    variant="subtle"
    :title="EPIC_CONFLICT_PENDING"
    :description="`Review carries on. A developer resolves it once, when the task's PR is approved${fileList(sync.files)}.`"
  />
  <EpicFixAlert
    v-else-if="sync?.state === 'fixing'"
    class="shrink-0"
    :sync="sync"
  />
  <AppAlert
    v-else-if="sync?.state === 'deciding'"
    class="shrink-0"
    color="warning"
    variant="subtle"
    title="This rebase needs your decision"
    :description="`${sync.question} It's in your Inbox${sync.taskRef ? ` on ${sync.taskRef}` : ''}. The rebase resumes when you answer.`"
  />
  <AppAlert
    v-else-if="sync?.state === 'failed'"
    class="shrink-0"
    color="error"
    variant="subtle"
    :title="epicStoppedLabel(sync.fix)"
    :description="sync.error"
    :actions="[{ label: 'Retry', loading: retry.isPending.value, onClick: retrySync }]"
  />
</template>
