<script setup lang="ts">
import type { DraftSession } from '@corral/contracts'
import { PRIORITY, TASK_TYPE, taskTypeIcon, priorityText } from '~/utils/labels'
import { PLAN_STATUS_BADGE } from '~/features/plan/utils/plan-attention'
import PlanSessionRow from '~/features/plan/components/PlanSessionRow.vue'

// The project's Drafts on the Plan tab, under the session they belong to
// (design/plan.md). A session or draft opens that session; a draft also
// opens itself in the flyout, or the task sheet on phones.
defineProps<{ sessions: DraftSession[], mobile?: boolean }>()
</script>

<template>
  <section
    v-if="sessions.length > 0"
    class="flex flex-col gap-3"
    data-testid="plan-drafts"
  >
    <h2 class="text-sm font-semibold text-foreground">
      Drafts
    </h2>
    <!-- One card per plan, its Drafts under its title -->
    <ul class="flex flex-col gap-3">
      <li
        v-for="session in sessions"
        :key="session.sessionId"
        data-testid="plan-drafts-session"
      >
        <AppCard
          class="gap-0 py-0"
          content-class="px-0"
        >
          <PlanSessionRow
            :to="`/plan/${session.sessionId}`"
            :title="session.title"
            :updated-at="session.updatedAt"
            :badge="session.planStatus === 'proposed' ? PLAN_STATUS_BADGE.needs_approval : null"
            :mobile="mobile"
            class="border-b border-border"
            data-testid="plan-drafts-header"
          />
          <ul class="divide-y divide-border">
            <li
              v-for="draft in session.drafts"
              :key="draft.taskId"
            >
              <NuxtLink
                :to="{ path: `/plan/${session.sessionId}`, query: { task: draft.ref } }"
                :class="['flex w-full items-center gap-3 px-4 text-sm hover:bg-muted', mobile ? 'min-h-12 py-3' : 'py-2']"
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
        </AppCard>
      </li>
    </ul>
  </section>
</template>
