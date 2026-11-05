<script setup lang="ts">
import TimeAgo from '~/components/shared/TimeAgo.vue'

// A Plan session as a card header row, shared by Open threads and Drafts on
// the new-session page (design/plan.md): chat icon, title, status badge,
// unread dot and updated time. Full width and at least 48px tall on phones.
defineProps<{
  to: string
  title: string
  updatedAt: string
  badge?: { label: string, color: 'primary' | 'info' | 'error' } | null
  unread?: boolean
  mobile?: boolean
}>()
</script>

<template>
  <NuxtLink
    :to="to"
    :class="['flex w-full items-center gap-3 px-4 text-sm hover:bg-muted', mobile ? 'min-h-12 py-3' : 'py-2.5']"
  >
    <Icon
      name="i-hugeicons-bubble-chat"
      class="size-4 shrink-0 text-muted-foreground"
    />
    <span class="flex min-w-0 flex-1 items-center gap-2">
      <span :class="['truncate', unread ? 'font-semibold text-foreground' : 'font-medium']">{{ title }}</span>
      <AppBadge
        v-if="badge"
        :label="badge.label"
        :color="badge.color"
        variant="subtle"
        size="xs"
        class="shrink-0"
      />
      <span
        v-if="unread"
        class="size-1.5 shrink-0 rounded-full bg-foreground"
        title="Unread"
        data-testid="plan-session-unread"
      ><span class="sr-only">, unread</span></span>
    </span>
    <span class="shrink-0 text-xs text-muted-foreground/70"><TimeAgo :at="updatedAt" /></span>
  </NuxtLink>
</template>
