<script setup lang="ts">
import type { AuditEntry, Comment } from '@corral/contracts'
import TimeAgo from '~/components/shared/TimeAgo.vue'
import { historyText } from '~/features/activity/utils/auditText'

defineProps<{ history: AuditEntry[], authorLabel: (actor: Comment['author']) => string }>()
</script>

<template>
  <ol class="mt-3 flex flex-col gap-2 text-sm">
    <li
      v-for="entry in history"
      :key="entry.id"
      class="flex gap-2"
    >
      <span
        class="mt-2 size-1.5 shrink-0 rounded-full bg-input"
        aria-hidden="true"
      />
      <div class="min-w-0">
        <span class="font-medium">{{ authorLabel(entry.actor) }}</span>
        <span class="text-muted-foreground"> {{ historyText(entry) }}</span>
        <span class="ms-2 text-xs text-muted-foreground/70"><TimeAgo :at="entry.createdAt" /></span>
        <template v-if="entry.action === 'run.ended' && entry.detail.outcome === 'pr_rebased' && entry.detail.review">
          <p class="mt-1 text-foreground/80">
            Review choice: {{ entry.detail.review }}
          </p>
          <p class="text-muted-foreground">
            Conflicted files:
          </p>
          <ul class="list-inside list-disc text-muted-foreground">
            <li
              v-for="file in (entry.detail.conflictedFiles as string[] ?? [])"
              :key="file"
              class="wrap-anywhere font-mono text-xs"
            >
              {{ file }}
            </li>
          </ul>
        </template>
      </div>
    </li>
  </ol>
</template>
