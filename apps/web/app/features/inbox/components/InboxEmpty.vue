<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { AGENTS_MAY_BE_WORKING, useInboxView } from '~/features/inbox/composables/useInboxView'
import { planSessionsQuery } from '~/queries/plan'
import { inboxItemLink } from '~/utils/labels'

// The Inbox's detail pane with no item to show. A link can outlive its item:
// send it to where the item's content lives, not to a new request.
const { inbox, count, selected, selectedId } = useInboxView()
const gone = computed(() => Boolean(inbox.value && selectedId.value && !selected.value))
const sessions = useQuery(computed(() => ({ ...planSessionsQuery(), enabled: gone.value })))
const source = computed(() => {
  const id = selectedId.value
  if (!gone.value || !id) return null
  if (sessions.data.value?.some(s => s.id === id)) return { to: `/plan/${id}`, label: 'Open in Plan' }
  const item = [...inbox.value!.activity, ...inbox.value!.resolved].find(i => i.taskId === id || ('epicId' in i && i.epicId === id))
  const link = item && inboxItemLink(item)
  return link && { to: link.to, label: `Open ${link.label.toLowerCase()}` }
})
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
    <template v-if="gone">
      <span class="font-medium text-foreground">This isn't waiting on you any more</span>
      <span>It was resolved, or it was only an update. There's nothing to decide here.</span>
      <AppButton
        v-if="source"
        :to="source.to"
        :label="source.label"
        color="neutral"
        variant="outline"
      />
    </template>
    <template v-else-if="inbox && count === 0">
      <Icon
        name="i-hugeicons-inbox"
        class="size-8"
      />
      <span class="font-medium text-foreground">No decisions waiting</span>
      <span>{{ AGENTS_MAY_BE_WORKING }}</span>
    </template>
    <span v-else>Pick an item.</span>
  </div>
</template>
