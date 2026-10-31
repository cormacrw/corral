<script setup lang="ts">
import type { InboxItem } from '@corral/contracts'
import { provideInboxView } from '~/composables/useInboxView'
import { inboxTypeBadge as typeBadge, timeAgo } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'

// The Inbox (design/inbox.md, D11): list and task flyout, with the selected
// item and its action tray in the child route. The list stays mounted across
// selections, so it keeps its tab, search and scroll.
const router = useRouter()
const device = useDevice()
useSeoMeta({ title: 'Inbox · Corral' })

const { list, inbox, error, tab, search, items, count, selectedId, selected, itemRoute, deleteThread } = provideInboxView()
function select(item: InboxItem) {
  void router.push(itemRoute(item))
}
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <div :class="['flex h-full min-h-0', device.isMobile.value ? 'flex-col' : 'max-md:flex-col']">
      <!-- Phones get the list and the item as separate screens (design/mobile.md) -->
      <InboxMobile
        v-if="device.isMobile.value"
        v-show="!selectedId"
      />
      <div
        v-else
        class="flex w-[380px] shrink-0 flex-col border-e border-default max-md:max-h-[360px] max-md:w-full max-md:border-e-0 max-md:border-b"
      >
        <!-- The tabs row lines up with the item and flyout headers (56px) -->
        <div class="flex h-14 shrink-0 items-center border-b border-default px-3">
          <UTabs
            v-model="tab"
            :items="[
              { label: `Inbox (${count})`, value: 'needsYou', icon: 'i-lucide-inbox' },
              { label: 'Activity', value: 'activity', icon: 'i-lucide-activity' },
              { label: `Resolved (${inbox?.resolved.length ?? 0})`, value: 'resolved', icon: 'i-lucide-circle-check' }
            ]"
            size="xs"
            :content="false"
            class="w-full"
          />
        </div>
        <div class="border-b border-default p-3">
          <UInput
            v-model="search"
            placeholder="Search"
            icon="i-lucide-search"
            size="sm"
            class="w-full"
          />
        </div>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          class="m-3"
          :actions="[{ label: 'Retry', onClick: () => list.refetch() }]"
        />
        <div
          v-else-if="!inbox"
          class="flex flex-col gap-2 p-3"
        >
          <USkeleton
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
              :class="['flex w-full gap-2 border-b border-default px-3 py-2 text-start', selectedId === item.id && 'bg-elevated']"
              @click="select(item)"
            >
              <PlanThreadRow
                v-if="item.type === 'plan_thread'"
                :item="item"
              />
              <template v-else>
                <span
                  v-if="item.type === 'release_notes' && item.unread"
                  class="mt-2 size-2 shrink-0 rounded-full bg-primary"
                  aria-label="Unread"
                />
                <AgentAvatar
                  :name="item.sender.name"
                  size="xs"
                />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2 text-xs text-muted">
                    <span class="font-medium text-default">{{ item.sender.name }}</span>
                    <span class="ms-auto">{{ timeAgo(item.at) }}</span>
                  </span>
                  <span class="block truncate text-sm font-medium">{{ item.subject }}</span>
                  <span class="line-clamp-2 text-xs text-muted">{{ markdownToPlainText(item.preview) }}</span>
                  <span
                    v-if="item.type === 'release_notes'"
                    class="block font-mono text-xs text-muted"
                  >{{ item.fromSha ? `${item.fromSha}…` : '' }}{{ item.toSha }}</span>
                  <span class="mt-1 flex items-center gap-2">
                    <UBadge
                      :label="typeBadge(item.type).label"
                      :color="typeBadge(item.type).color"
                      variant="subtle"
                      size="xs"
                    />
                    <span class="flex items-center gap-1 text-xs text-muted">
                      <ProjectThumbnail
                        :project="item.project"
                        :size="16"
                      />{{ item.project.name }}
                    </span>
                  </span>
                </span>
              </template>
            </button>
            <UButton
              v-if="item.type === 'plan_thread'"
              icon="i-lucide-trash-2"
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
            class="p-6 text-center text-sm text-muted"
          >
            All clear. Nothing here right now.
          </li>
        </ul>
      </div>

      <!-- Always rendered: the shell's route only catches up when a child finishes -->
      <NuxtPage />
      <TaskFlyout v-if="!device.isMobile.value && selected?.type !== 'plan_thread'" />
    </div>
  </UDashboardPanel>
</template>
