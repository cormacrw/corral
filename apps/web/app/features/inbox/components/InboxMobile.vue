<script setup lang="ts">
import { useInboxView } from '~/features/inbox/composables/useInboxView'
import InboxItemRow from '~/features/inbox/components/InboxItemRow.vue'

// The Inbox list on a phone (design/inbox.md, design/mobile.md), a screen of
// its own at /inbox. The item is InboxMobileItem.
const { list, inbox, error, tab, search, items, count, emptyText, deleteThread } = useInboxView()

const searching = ref(Boolean(search.value))
function toggleSearch() {
  searching.value = !searching.value
  if (!searching.value) search.value = ''
}

// Server order: newest first, task items and threads together (D11)
const tabs = computed(() => [
  { label: 'Inbox', value: 'needsYou', icon: 'i-hugeicons-inbox', count: count.value },
  { label: 'Activity', value: 'activity', icon: 'i-hugeicons-pulse-01', count: null },
  { label: 'Resolved', value: 'resolved', icon: 'i-hugeicons-checkmark-circle-02', count: inbox.value?.resolved.length ?? 0 }
])
</script>

<template>
  <div
    class="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain"
    data-testid="inbox-list"
  >
    <div class="flex shrink-0 flex-col gap-3 border-b border-border p-3">
      <AppInput
        v-if="searching"
        v-model="search"
        placeholder="Search"
        icon="i-hugeicons-search-01"
        autofocus
      />
      <div class="flex items-center gap-2">
        <AppTabs
          v-model="tab"
          :items="tabs"
          :content="false"
          class="min-w-0 flex-1"
          list-class="w-full"
          trigger-class="gap-1 px-1.5 max-[375px]:[&>.iconify]:hidden"
        >
          <template #trailing="{ item }">
            <span
              v-if="item.count !== null"
              class="text-xs opacity-75"
            >{{ item.count }}</span>
          </template>
        </AppTabs>
        <AppButton
          icon="i-hugeicons-search-01"
          variant="ghost"
          color="neutral"
          aria-label="Search the Inbox"
          :aria-pressed="searching"
          @click="toggleSearch"
        />
      </div>
    </div>
    <AppLoadError
      v-if="error"
      :title="error"
      class="m-4"
      :retry="() => list.refetch()"
    />
    <div
      v-else-if="!inbox"
      class="flex flex-col gap-3 p-4"
    >
      <UiSkeleton
        v-for="i in 4"
        :key="i"
        class="h-24 w-full"
      />
    </div>
    <ul
      v-else
      class="shrink-0"
    >
      <li
        v-for="item in items"
        :key="item.id"
      >
        <!-- Only Plan threads swipe to delete; task items are resolved from their screen -->
        <SwipeToDelete
          v-if="item.type === 'plan_thread'"
          @delete="deleteThread(item)"
        >
          <NuxtLink
            :to="`/inbox/${item.id}`"
            draggable="false"
            class="flex gap-3 border-b border-border px-4 py-3 active:bg-muted"
          >
            <PlanThreadRow
              :item="item"
              mobile
            />
          </NuxtLink>
        </SwipeToDelete>
        <NuxtLink
          v-else
          :to="`/inbox/${item.id}`"
          class="flex gap-3 border-b border-border px-4 py-3 active:bg-muted"
        >
          <InboxItemRow
            :item="item"
            mobile
          />
        </NuxtLink>
      </li>
      <li
        v-if="items.length === 0"
        class="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground"
      >
        <Icon
          name="i-hugeicons-inbox"
          class="size-8"
        />
        {{ emptyText }}
      </li>
      <li
        v-else-if="tab === 'needsYou'"
        class="p-6 text-center text-sm text-muted-foreground"
      >
        That's every decision waiting on you.
      </li>
    </ul>
  </div>
</template>
