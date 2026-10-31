<script setup lang="ts">
import { needsAttention } from '@corral/contracts/client'
import type { InboxItem } from '@corral/contracts'
import { useInboxView } from '~/composables/useInboxView'
import InboxItemRow from '~/components/InboxItemRow.vue'

// The Inbox list on a phone (design/inbox.md, design/mobile.md), a screen of
// its own at /inbox. The item is InboxMobileItem.
const { list, inbox, error, tab, search, items } = useInboxView()

const searching = ref(Boolean(search.value))
function toggleSearch() {
  searching.value = !searching.value
  if (!searching.value) search.value = ''
}

// A thread being deleted leaves the list at once, while its Undo toast shows
const deleting = usePlanThreadDelete()
const isHidden = (item: InboxItem) => item.type === 'plan_thread' && deleting.pending.value.includes(item.sessionId)
const listed = computed(() => items.value.filter(i => !isHidden(i)))
// Server order: newest first, task items and threads together (D11)
const tabs = computed(() => [
  { label: 'Inbox', value: 'needsYou', icon: 'i-lucide-inbox', count: (inbox.value?.needsYou ?? []).filter(i => !isHidden(i) && needsAttention(i)).length },
  { label: 'Activity', value: 'activity', icon: 'i-lucide-activity', count: null },
  { label: 'Resolved', value: 'resolved', icon: 'i-lucide-circle-check', count: inbox.value?.resolved.length ?? 0 }
])
</script>

<template>
  <div
    class="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain"
    data-testid="inbox-list"
  >
    <div class="flex shrink-0 flex-col gap-3 border-b border-default p-3">
      <UInput
        v-if="searching"
        v-model="search"
        placeholder="Search"
        icon="i-lucide-search"
        autofocus
      />
      <div class="flex items-center gap-2">
        <UTabs
          v-model="tab"
          :items="tabs"
          :content="false"
          :ui="{ trigger: 'gap-1 px-1.5', label: 'overflow-visible', leadingIcon: 'max-[375px]:hidden' }"
          class="min-w-0 flex-1"
        >
          <template #trailing="{ item }">
            <span
              v-if="item.count !== null"
              class="text-xs opacity-75"
            >{{ item.count }}</span>
          </template>
        </UTabs>
        <UButton
          icon="i-lucide-search"
          variant="ghost"
          color="neutral"
          aria-label="Search the Inbox"
          :aria-pressed="searching"
          @click="toggleSearch"
        />
      </div>
    </div>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      class="m-4"
      :actions="[{ label: 'Retry', onClick: () => list.refetch() }]"
    />
    <div
      v-else-if="!inbox"
      class="flex flex-col gap-3 p-4"
    >
      <USkeleton
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
        v-for="item in listed"
        :key="item.id"
      >
        <!-- Only Plan threads swipe to delete; task items are resolved from their screen -->
        <SwipeToDelete
          v-if="item.type === 'plan_thread'"
          @delete="deleting.remove(item.sessionId)"
        >
          <NuxtLink
            :to="`/inbox/${item.id}`"
            draggable="false"
            class="flex gap-3 border-b border-default px-4 py-3 active:bg-elevated"
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
          class="flex gap-3 border-b border-default px-4 py-3 active:bg-elevated"
        >
          <InboxItemRow
            :item="item"
            mobile
          />
        </NuxtLink>
      </li>
      <li
        v-if="listed.length === 0"
        class="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted"
      >
        <UIcon
          name="i-lucide-circle-check"
          class="size-8 text-success"
        />
        All clear. Nothing here right now.
      </li>
      <li
        v-else-if="tab === 'needsYou'"
        class="p-6 text-center text-sm text-muted"
      >
        That's everything in your Inbox.
      </li>
    </ul>
  </div>
</template>
