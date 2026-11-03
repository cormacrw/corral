<script setup lang="ts">
import type { InboxPanelContext } from '~/features/inbox/composables/useInboxPanel'
import { useInboxView, type EpicInboxItem } from '~/features/inbox/composables/useInboxView'
import { inboxItemLink } from '~/utils/labels'

// An Inbox item on a phone (design/inbox.md, design/mobile.md), a screen of its
// own at /inbox/:itemId. useInboxItem owns the data and the actions; task items
// are the Option D panel under the focused header.
const props = defineProps<{ epicItem: EpicInboxItem | null, epicGone?: boolean, ctx: InboxPanelContext }>()
const { list, inbox, error, selected, moveToNext } = useInboxView()
const panel = ref<{ send: () => Promise<boolean> } | null>(null)
defineExpose({ send: () => panel.value?.send() ?? Promise.resolve(false) })

// Epics, runners and release notes have panes of their own; the rest are task items
const ownPane = computed(() => !!props.epicItem || selected.value?.type === 'runner_update' || selected.value?.type === 'release_notes')
const taskLink = computed(() => {
  const link = selected.value && !ownPane.value ? inboxItemLink(selected.value) : null
  // An item can outlive its task, and then there's no task page to open
  return link?.label === 'Task' && !props.ctx.task ? null : link
})
</script>

<template>
  <InboxMobilePlanThread
    v-if="selected?.type === 'plan_thread'"
    :item="selected"
  />
  <div
    v-else
    class="flex h-full min-h-0 flex-col"
    :data-testid="ownPane ? undefined : 'inbox-item'"
  >
    <MobilePageHeader compact>
      <template #actions>
        <AppButton
          v-if="taskLink"
          :to="taskLink.to"
          :label="taskLink.label"
          icon="i-ri-list-unordered"
          class="tap-target"
          variant="ghost"
          color="neutral"
        />
      </template>
    </MobilePageHeader>
    <InboxEpicPanel
      v-if="epicItem"
      :key="epicItem.id"
      :item="epicItem"
      :gone="epicGone"
      mobile
      @resolved="moveToNext"
    />
    <InboxRunnerUpdate
      v-else-if="selected?.type === 'runner_update'"
      :item="selected"
    />
    <InboxReleaseNotes
      v-else-if="selected?.type === 'release_notes'"
      :item="selected"
    />
    <InboxPanel
      v-else-if="selected"
      ref="panel"
      :ctx="ctx"
      mobile
    />
    <AppLoadError
      v-else-if="error"
      :title="error"
      class="m-4"
      :retry="() => list.refetch()"
    />
    <div
      v-else-if="!inbox"
      class="flex flex-col gap-3 p-4"
    >
      <UiSkeleton class="h-12 w-full" />
      <UiSkeleton class="h-32 w-full" />
    </div>
    <InboxEmpty v-else />
  </div>
</template>
