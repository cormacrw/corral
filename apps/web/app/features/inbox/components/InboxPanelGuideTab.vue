<script setup lang="ts">
import type { PullRequestDetail, Task } from '@corral/contracts'
import { usePullRequestGuide } from '~/features/inbox/composables/usePullRequestGuide'
import InboxPanelGuide from '~/features/inbox/components/InboxPanelGuide.vue'

// Option A of guided review (COR-518, design, not recommended): a Guide tab
// beside Code diff, one step at a time. "In Files" goes to the Code diff tab.
const props = defineProps<{ pr: PullRequestDetail, slug: string, taskRef: string, criteria: Task['acceptanceCriteria'], mobile?: boolean }>()
const emit = defineEmits<{ openDiff: [] }>()
const g = usePullRequestGuide(props.slug, props.taskRef, () => props.pr, () => props.criteria)
</script>

<template>
  <InboxPanelGuide
    :g="g"
    :pr="pr"
    :mobile="mobile"
    layout="walkthrough"
    @open-file="emit('openDiff')"
  />
</template>
