<script setup lang="ts">
import { computed } from 'vue'
import type { AuditEntry, Comment, Run } from '@corral/contracts'
import TimeAgo from '~/components/shared/TimeAgo.vue'
import { historyText } from '~/features/activity/utils/auditText'
import { runBadge } from '~/utils/labels'

const props = defineProps<{ comments: Comment[], runs: Run[], history: AuditEntry[], authorLabel: (actor: Comment['author']) => string }>()

const FEED_ACTIONS = ['task.created', 'task.updated', 'task.transition', 'task.paused', 'task.resumed', 'task.deleted']
// Task mutations, comments and runs that ended with an error, oldest first
const items = computed(() => [
  ...props.comments.map(comment => ({ id: comment.id, at: comment.createdAt, comment, run: null, audit: null })),
  ...props.runs.filter(run => run.error && run.endedAt).map(run => ({ id: run.id, at: run.endedAt!, comment: null, run, audit: null })),
  ...props.history.filter(entry => FEED_ACTIONS.includes(entry.action)).map(audit => ({ id: audit.id, at: audit.createdAt, comment: null, run: null, audit }))
].sort((a, b) => a.at.localeCompare(b.at)))
</script>

<template>
  <template
    v-for="item in items"
    :key="item.id"
  >
    <AuditActivity
      v-if="item.audit"
      :entry="item.audit"
      :text="historyText(item.audit)"
    />
    <div
      v-else-if="item.comment"
      class="flex gap-2"
    >
      <AgentAvatar
        :name="authorLabel(item.comment.author)"
        size="xs"
      />
      <div class="min-w-0 flex-1 rounded-lg bg-muted px-3 py-2 text-sm">
        <div class="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span class="font-medium text-foreground">{{ authorLabel(item.comment.author) }}</span>
          <span><TimeAgo :at="item.comment.createdAt" /></span>
          <AppBadge
            v-if="item.comment.pinned"
            label="Pinned"
            size="xs"
            variant="subtle"
          />
        </div>
        <MarkdownText :text="item.comment.body" />
      </div>
    </div>
    <div
      v-else-if="item.run"
      class="flex gap-2 text-sm"
      data-testid="activity-run-error"
    >
      <span
        class="mx-1.5 mt-1.5 size-2 shrink-0 rounded-full bg-destructive"
        aria-hidden="true"
      />
      <p class="min-w-0 flex-1 text-muted-foreground">
        <span class="font-medium text-foreground">{{ item.run.agentName }}</span>
        run #{{ item.run.number }} ended {{ runBadge(item.run).label.toLowerCase() }}: {{ item.run.error }}
        <span class="text-xs">· <TimeAgo :at="item.run.endedAt!" /></span>
      </p>
    </div>
  </template>
  <p
    v-if="items.length === 0"
    class="text-sm text-muted-foreground"
  >
    No comments yet.
  </p>
</template>
