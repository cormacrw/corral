<script setup lang="ts">
import type { InboxPanel, InboxPanelContext } from '~/features/inbox/composables/useInboxPanel'

// The links out of the panel: the PR or a design's preview in a new tab, the
// way to review a design, and the task. On a wide screen the task opens in the
// docked flyout; a phone has no flyout, so an Activity item links to the task.
defineProps<{ ctx: InboxPanelContext, p: InboxPanel, mobile?: boolean }>()
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-2"
    data-testid="inbox-artifacts"
  >
    <InboxDesignReviewLink
      :task="ctx.task"
      size="sm"
    />
    <AppButton
      v-if="p.pr.value"
      :to="p.pr.value.url"
      target="_blank"
      :label="p.pr.value.number ? `PR #${p.pr.value.number}` : 'Open PR'"
      icon="i-hugeicons-git-pull-request"
      trailing-icon="i-hugeicons-arrow-up-right-01"
      color="neutral"
      variant="outline"
      size="sm"
    />
    <AppButton
      v-if="p.preview.value"
      :to="p.preview.value.url"
      target="_blank"
      :label="p.preview.value.label"
      icon="i-hugeicons-laptop-phone-sync"
      trailing-icon="i-hugeicons-arrow-up-right-01"
      color="neutral"
      variant="outline"
      size="sm"
    />
    <AppButton
      v-if="!mobile && ctx.task"
      :label="`Task ${ctx.item.taskRef}`"
      icon="i-hugeicons-task-01"
      color="neutral"
      :variant="ctx.taskOpen ? 'subtle' : 'outline'"
      size="sm"
      :aria-pressed="ctx.taskOpen"
      title="Task details"
      @click="ctx.toggleTask"
    />
    <AppButton
      v-else-if="mobile && ctx.item.type === 'activity' && ctx.task"
      :to="`/tasks/${ctx.item.taskRef}`"
      label="Open task"
      color="neutral"
      variant="outline"
      size="sm"
    />
  </div>
</template>
