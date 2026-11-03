<script setup lang="ts">
import type { ProjectOverview } from '~/features/projects/composables/useProjectOverview'
import { inboxItemBadge } from '~/utils/labels'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// The project's share of Needs you: a card on the web, full-width rows on a phone
defineProps<{ items: ProjectOverview['needsYou']['value'], loading: boolean, mobile?: boolean }>()
</script>

<template>
  <section :class="!mobile && 'rounded-lg border border-border'">
    <header :class="['flex items-center gap-2', mobile ? 'mb-2' : 'border-b border-border px-3 py-2']">
      <OverviewHeading :mobile="mobile">
        Needs you
      </OverviewHeading>
      <AppBadge
        :label="String(items.length)"
        size="sm"
        :color="items.length ? 'primary' : 'neutral'"
        :variant="mobile && items.length ? 'solid' : 'subtle'"
      />
      <AppButton
        to="/inbox"
        label="Open Inbox"
        variant="link"
        size="sm"
        :class="['ms-auto', mobile && 'px-0']"
      />
    </header>
    <ul
      v-if="items.length > 0"
      :class="mobile && '-mx-4 divide-y divide-border border-y border-border'"
    >
      <li
        v-for="item in items"
        :key="item.id"
      >
        <NuxtLink
          v-if="mobile"
          :to="`/inbox/${item.id}`"
          class="flex items-center gap-2 px-4 py-3 active:bg-muted"
        >
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline gap-2">
              <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ item.taskRef }}</span>
              <span class="truncate text-sm">{{ item.subject }}</span>
            </span>
            <span class="mt-1 flex items-center gap-2">
              <AppBadge
                :label="inboxItemBadge(item).label"
                :color="inboxItemBadge(item).color"
                variant="subtle"
                size="sm"
              />
              <span class="text-xs text-muted-foreground/70"><TimeAgo :at="item.at" /></span>
            </span>
          </span>
          <Icon
            name="i-hugeicons-arrow-right-01"
            class="size-4 shrink-0 text-muted-foreground/70"
          />
        </NuxtLink>
        <NuxtLink
          v-else
          :to="`/inbox/${item.id}`"
          class="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
        >
          <AppBadge
            :label="inboxItemBadge(item).label"
            :color="inboxItemBadge(item).color"
            size="xs"
            variant="subtle"
            class="shrink-0"
          />
          <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ item.taskRef }}</span>
          <span class="min-w-0 flex-1 truncate">{{ item.subject }}</span>
          <span class="shrink-0 text-xs text-muted-foreground/70"><TimeAgo :at="item.at" /></span>
        </NuxtLink>
      </li>
    </ul>
    <template v-else-if="loading">
      <UiSkeleton
        v-if="mobile"
        class="h-12"
      />
      <div
        v-else
        class="flex flex-col gap-2 p-3"
      >
        <UiSkeleton class="h-5 w-full" />
        <UiSkeleton class="h-5 w-2/3" />
      </div>
    </template>
    <p
      v-else
      :class="['text-sm text-muted-foreground', !mobile && 'px-3 py-4']"
    >
      Nothing is waiting on you.
    </p>
  </section>
</template>
