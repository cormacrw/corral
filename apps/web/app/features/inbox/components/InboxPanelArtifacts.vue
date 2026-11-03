<script setup lang="ts">
import type { InboxPanel, InboxPanelContext } from '~/features/inbox/composables/useInboxPanel'

// The links out of the panel: the PR or a design's preview in a new tab, the
// way to review a design, and an Activity item's task
defineProps<{ ctx: InboxPanelContext, p: InboxPanel }>()
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
      icon="i-ri-git-pull-request-line"
      trailing-icon="i-ri-arrow-right-up-line"
      color="neutral"
      variant="outline"
      size="sm"
    />
    <AppButton
      v-if="p.preview.value"
      :to="p.preview.value.url"
      target="_blank"
      :label="p.preview.value.label"
      icon="i-ri-device-line"
      trailing-icon="i-ri-arrow-right-up-line"
      color="neutral"
      variant="outline"
      size="sm"
    />
    <AppButton
      v-if="ctx.item.type === 'activity' && ctx.task"
      :to="`/tasks/${ctx.item.taskRef}`"
      label="Open task"
      color="neutral"
      variant="outline"
      size="sm"
    />
  </div>
</template>
