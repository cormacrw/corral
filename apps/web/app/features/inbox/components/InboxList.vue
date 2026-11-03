<script setup lang="ts">
import { taskNumber } from '~/utils/labels'
import type { InboxItem } from '@corral/contracts'
import { isTaskItem, useInboxView } from '~/features/inbox/composables/useInboxView'
import InboxItemRow from '~/features/inbox/components/InboxItemRow.vue'

// The Inbox list on a wide screen, beside the selected item. A phone has
// InboxMobile. It stays mounted across selections, so it keeps its tab, search
// and scroll.
const router = useRouter()
const prefetch = useTaskPrefetch()
const { list, inbox, error, tab, search, items, count, emptyText, selectedId, itemRoute, deleteThread } = useInboxView()

const tabs = computed(() => [
  { label: `Inbox (${count.value})`, value: 'needsYou', icon: 'i-ri-inbox-line' },
  { label: 'Activity', value: 'activity', icon: 'i-ri-pulse-line' },
  { label: `Resolved (${inbox.value?.resolved.length ?? 0})`, value: 'resolved', icon: 'i-ri-checkbox-circle-line' }
])
function select(item: InboxItem) {
  void router.push(itemRoute(item))
}
const hover = (item: InboxItem) => isTaskItem(item) ? prefetch({ ref: item.taskRef, number: taskNumber(item.taskRef) }, item.project.slug) : undefined
</script>

<template>
  <div class="flex w-[380px] shrink-0 flex-col border-e border-border max-md:max-h-[360px] max-md:w-full max-md:border-e-0 max-md:border-b">
    <!-- The tabs row lines up with the item and flyout headers (56px) -->
    <div class="flex h-14 shrink-0 items-center border-b border-border px-3">
      <AppTabs
        v-model="tab"
        :items="tabs"
        :content="false"
        class="w-full"
        list-class="w-full"
      />
    </div>
    <div class="border-b border-border p-3">
      <AppInput
        v-model="search"
        placeholder="Search"
        icon="i-ri-search-line"
        size="sm"
        class="w-full"
      />
    </div>
    <AppLoadError
      v-if="error"
      :title="error"
      class="m-3"
      :retry="() => list.refetch()"
    />
    <div
      v-else-if="!inbox"
      class="flex flex-col gap-2 p-3"
    >
      <UiSkeleton
        v-for="i in 4"
        :key="i"
        class="h-16 w-full"
      />
    </div>
    <ul
      v-else
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <li
        v-for="item in items"
        :key="item.id"
        class="group relative"
      >
        <button
          type="button"
          :class="['flex w-full gap-2 border-b border-border px-3 py-2 text-start', selectedId === item.id && 'bg-muted']"
          v-bind="hover(item)"
          @click="select(item)"
        >
          <PlanThreadRow
            v-if="item.type === 'plan_thread'"
            :item="item"
          />
          <InboxItemRow
            v-else
            :item="item"
          />
        </button>
        <AppButton
          v-if="item.type === 'plan_thread'"
          icon="i-ri-delete-bin-line"
          variant="soft"
          color="error"
          size="xs"
          aria-label="Delete thread"
          title="Delete thread"
          class="absolute end-3 bottom-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          @click="deleteThread(item)"
        />
      </li>
      <li
        v-if="items.length === 0"
        class="p-6 text-center text-sm text-muted-foreground"
      >
        {{ emptyText }}
      </li>
    </ul>
  </div>
</template>
