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
const { list, inbox, error, tab, tabItems, search, items, emptyText, selectedId, itemRoute } = useInboxView()

const tabs = computed(() => tabItems.value.map(t => ({ ...t, label: `${t.label} (${t.count})` })))
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
        icon="i-hugeicons-search-01"
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
      >
        <button
          type="button"
          :class="['flex w-full gap-2 border-b border-border px-3 py-2 text-start', selectedId === item.id && 'bg-muted']"
          v-bind="hover(item)"
          @click="select(item)"
        >
          <InboxItemRow
            :item="item"
          />
        </button>
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
