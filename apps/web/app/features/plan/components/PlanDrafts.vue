<script setup lang="ts">
import type { DraftSession } from '@corral/contracts'
import { PRIORITY, TASK_TYPE, taskTypeIcon, priorityText } from '~/utils/labels'
import TimeAgo from '~/components/shared/TimeAgo.vue'

// The project's Drafts on the Plan tab, under the session they belong to
// (design/plan.md). A session or draft opens that session; a draft also
// opens itself in the flyout, or the task sheet on phones.
defineProps<{ sessions: DraftSession[], mobile?: boolean }>()
</script>

<template>
  <section
    v-if="sessions.length > 0"
    class="rounded-lg border border-border"
    data-testid="plan-drafts"
  >
    <h2 class="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
      Drafts
    </h2>
    <ul class="divide-y divide-border">
      <li
        v-for="session in sessions"
        :key="session.sessionId"
        data-testid="plan-drafts-session"
      >
        <NuxtLink
          :to="`/plan/${session.sessionId}`"
          :class="['flex w-full items-center gap-3 px-3 text-sm hover:bg-muted', mobile ? 'min-h-12 py-3' : 'py-2']"
          data-testid="plan-drafts-header"
        >
          <Icon
            name="i-hugeicons-bubble-chat"
            class="size-4 shrink-0 text-muted-foreground"
          />
          <span class="flex min-w-0 flex-1 items-center gap-2">
            <span class="truncate font-medium">{{ session.title }}</span>
            <AppBadge
              v-if="session.planStatus === 'proposed'"
              label="Needs approval"
              color="primary"
              variant="subtle"
              size="xs"
            />
          </span>
          <span class="shrink-0 text-xs text-muted-foreground/70"><TimeAgo :at="session.updatedAt" /></span>
        </NuxtLink>
        <ul>
          <li
            v-for="draft in session.drafts"
            :key="draft.taskId"
          >
            <NuxtLink
              :to="{ path: `/plan/${session.sessionId}`, query: { task: draft.ref } }"
              :class="['flex w-full items-center gap-3 ps-10 pe-3 text-sm hover:bg-muted', mobile ? 'min-h-12 py-3' : 'py-1.5']"
              data-testid="plan-drafts-draft"
            >
              <span class="w-14 shrink-0 font-mono text-xs text-muted-foreground">{{ draft.ref }}</span>
              <Icon
                :name="taskTypeIcon(draft.type)"
                :aria-label="TASK_TYPE[draft.type]"
                class="size-4 shrink-0 text-muted-foreground"
              />
              <span class="min-w-0 flex-1 truncate">{{ draft.title }}</span>
              <span :class="['shrink-0 text-xs', priorityText(draft)]">{{ PRIORITY[draft.priority].label }}</span>
            </NuxtLink>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>
