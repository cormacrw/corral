<script setup lang="ts">
import { planThreadPath } from '~/utils/routes'
import { ROLE_LABELS } from '@corral/core'
import type { AuditEntry } from '@corral/contracts'
import { actorName, confirmedByYou } from '~/features/activity/utils/auditText'
import { timeAgo } from '~/utils/labels'

const props = defineProps<{ entry: AuditEntry, text: string }>()
const fieldLabels: Record<string, string> = { acceptanceCriteria: 'acceptance criteria', implementationPlan: 'implementation plan', humanReview: 'human review', epicId: 'epic', dependsOn: 'dependencies', reviewMode: 'review mode' }
const displayText = computed(() => props.text.replace(/\b(acceptanceCriteria|implementationPlan|humanReview|epicId|dependsOn|reviewMode)\b/g, field => fieldLabels[field]!))
const sessionId = computed(() => {
  const actor = props.entry.actor
  return actor.kind === 'agent' ? actor.sessionId : actor.kind === 'human' ? actor.viaPm?.sessionId : undefined
})
const author = computed(() => actorName(props.entry.actor, role => props.entry.agentName ?? ROLE_LABELS[role]))
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
      <span class="font-medium text-foreground">{{ author }}</span><template v-if="confirmedByYou(entry.actor)">
        · confirmed by you
      </template>
      {{ ' ' }}{{ displayText }}
      <NuxtLink
        v-if="sessionId"
        :to="planThreadPath(sessionId)"
        class="ml-1 text-brand hover:underline"
      >conversation</NuxtLink>
      <span class="ml-1 text-xs">· {{ timeAgo(entry.createdAt) }}</span>
    </p>
  </div>
</template>
