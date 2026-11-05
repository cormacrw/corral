<script setup lang="ts">
import type { AuditEntry } from '@corral/contracts'
import { actorLabel } from '~/features/activity/utils/auditText'
import { ROLE, timeAgo } from '~/utils/labels'

const props = defineProps<{ entry: AuditEntry, text: string }>()
const fieldLabels: Record<string, string> = { acceptanceCriteria: 'acceptance criteria', implementationPlan: 'implementation plan', humanReview: 'human review', epicId: 'epic', dependsOn: 'dependencies', reviewMode: 'review mode' }
const displayText = computed(() => props.text.replace(/\b(acceptanceCriteria|implementationPlan|humanReview|epicId|dependsOn|reviewMode)\b/g, field => fieldLabels[field]!))
const sessionId = computed(() => {
  const actor = props.entry.actor
  return actor.kind === 'agent' ? actor.sessionId : actor.kind === 'human' ? actor.viaPm?.sessionId : undefined
})
const author = computed(() => actorLabel(props.entry.actor, agent => ROLE[agent.role]))
</script>

<template>
  <div
    class="flex items-start gap-2 text-sm"
    data-testid="audit-activity"
  >
    <AgentAvatar
      :name="author"
      size="xs"
    />
    <p class="min-w-0 flex-1 text-muted-foreground">
      <span class="font-medium text-foreground">{{ author }}</span>
      {{ ' ' }}{{ displayText }}
      <NuxtLink
        v-if="sessionId"
        :to="`/plan/${sessionId}`"
        class="ml-1 text-brand hover:underline"
      >conversation</NuxtLink>
      <span class="ml-1 text-xs">· {{ timeAgo(entry.createdAt) }}</span>
    </p>
  </div>
</template>
