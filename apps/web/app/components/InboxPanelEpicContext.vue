<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { Task } from '@corral/contracts'
import { epicQuery } from '~/queries/epics'

const props = defineProps<{ task: Task | null, prNumber: string | null, canAct: boolean }>()
const epic = useQuery(computed(() => ({ ...epicQuery(props.task?.epicId ?? ''), enabled: Boolean(props.task?.epicId) })))
const grouped = computed(() => epic.data.value && ['epic', 'each_task'].includes(epic.data.value.reviewMode) ? epic.data.value : null)
const hasPr = computed(() => props.prNumber && props.task?.type !== 'spike' && props.task?.type !== 'design')
const { openEpic } = useTaskFlyout()
</script>

<template>
  <div
    v-if="grouped"
    class="flex flex-col gap-1 text-sm text-muted"
    data-testid="inbox-epic-context"
  >
    <p class="flex items-center gap-1.5">
      <UIcon
        name="i-lucide-git-branch"
        class="size-4 shrink-0"
      />
      <span>Part of
        <button
          type="button"
          class="font-medium text-default hover:underline"
          @click="openEpic(grouped.id)"
        >{{ grouped.title }}</button>.
        You'll review it all together at the epic PR.</span>
    </p>
    <p v-if="canAct && hasPr">
      Approve and merge PR #{{ prNumber }} into the epic branch, or request changes.
    </p>
  </div>
</template>
