<script setup lang="ts">
import type { PlanSession } from '@corral/contracts'
import { computed } from 'vue'
import PlanSessionRow from '~/features/plan/components/PlanSessionRow.vue'

// The scope's open threads on the Plan tab, above its Drafts
// (design/plan.md). The parent passes the scope's sessions; closed ones
// drop out here, so a plan.session close leaves the list live. Rows
// carry the unread dot but no status badge.
const props = defineProps<{ sessions: PlanSession[], mobile?: boolean }>()
const open = computed(() => props.sessions
  .filter(s => !s.closed)
  .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
</script>

<template>
  <section
    v-if="open.length > 0"
    class="flex flex-col gap-3"
    data-testid="plan-open-threads"
  >
    <h2 class="text-sm font-semibold text-foreground">
      Open threads
    </h2>
    <AppCard
      class="gap-0 py-0"
      content-class="px-0"
    >
      <ul class="divide-y divide-border">
        <li
          v-for="session in open"
          :key="session.id"
        >
          <PlanSessionRow
            :to="`/plan/${session.id}`"
            :title="session.title"
            :updated-at="session.updatedAt"
            :unread="session.unread"
            :mobile="mobile"
            data-testid="plan-open-thread"
          />
        </li>
      </ul>
    </AppCard>
  </section>
</template>
