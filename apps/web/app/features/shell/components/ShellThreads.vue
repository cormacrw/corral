<script setup lang="ts">
import { planAttention } from '~/features/plan/utils/plan-attention'

const { active, sessions: threads, close: closeThread } = useOpenPlanSessions()
const { threadColor } = useSidebarData()
const STATUS_DOT: Record<string, string> = { needs_approval: 'bg-primary', question: 'bg-info', failed: 'bg-destructive' }
</script>

<template>
  <div
    v-if="threads.length"
    aria-label="Open Plan threads"
    class="ms-3.5 flex max-h-64 flex-col gap-0.5 overflow-y-auto overscroll-contain border-s ps-2 group-data-[collapsible=icon]:hidden"
  >
    <div
      v-for="thread in threads"
      :key="thread.id"
      :class="['group/thread flex min-w-0 items-center rounded-md', active === thread.id && 'bg-sidebar-accent text-brand']"
      data-testid="plan-thread"
    >
      <NuxtLink
        :to="`/plan/${thread.id}`"
        :title="thread.title"
        :aria-current="active === thread.id ? 'page' : undefined"
        class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
      >
        <span
          class="size-2 shrink-0 rounded-full bg-muted"
          :style="{ background: threadColor(thread.projectId) }"
          aria-hidden="true"
        />
        <span :class="['min-w-0 flex-1 truncate', planAttention(thread) && 'font-semibold text-foreground']">{{ thread.title }}</span>
        <span
          v-if="thread.projectId === null"
          class="shrink-0 text-xs text-muted-foreground"
        >Global</span>
        <Icon
          v-if="thread.activeRunId"
          name="i-ri-loader-4-line"
          class="size-3.5 shrink-0 animate-spin text-muted-foreground"
          aria-label="Juno is working"
        />
        <AppTooltip
          v-else-if="planAttention(thread)"
          :text="planAttention(thread)!"
        >
          <span
            :aria-label="planAttention(thread)!"
            :class="['size-2 shrink-0 rounded-full', STATUS_DOT[thread.status] ?? 'bg-foreground']"
          />
        </AppTooltip>
      </NuxtLink>
      <PlanCloseThread
        :session="thread"
        menu
      />
      <AppButton
        icon="i-ri-close-line"
        size="xs"
        variant="ghost"
        color="neutral"
        :aria-label="`Close ${thread.title}`"
        class="shrink-0 opacity-0 group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 focus-visible:opacity-100"
        @click="closeThread(thread)"
      />
    </div>
  </div>
</template>
