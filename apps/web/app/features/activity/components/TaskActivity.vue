<script setup lang="ts">
import { ROLE_LABELS } from '@corral/core'
import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import type { AuditEntry, Comment, Evidence, Review, Run, Task } from '@corral/contracts'
import type { AgentRole } from '@corral/core'
import { actorLabel, actorName } from '~/features/activity/utils/auditText'

// The Activity, Evidence and History tabs of a task (design/task.md)
const props = defineProps<{
  task: Task
  taskRef: string
  slug: string
  comments: Comment[]
  history: AuditEntry[]
  runs: Run[]
  evidence: Evidence[]
  reviews: Review[]
  draft: { text: Ref<string> }
  hint: string
  send: (body: string) => Promise<boolean>
}>()

const shell = useShell()
// PR bodies link to ?evidence=1
const tab = ref<'activity' | 'evidence' | 'history'>(useRoute().query.evidence ? 'evidence' : 'activity')
const tabs = computed(() => [{ label: 'Activity', value: 'activity' }, { label: `Evidence (${props.evidence.length})`, value: 'evidence' }, { label: 'History', value: 'history' }])

const agentName = (role: AgentRole, runId: string | null) => {
  const run = runId ? props.runs.find(r => r.id === runId) : undefined
  if (run) return run.agentName
  return role === 'pm' ? (shell.agents.find(a => a.role === 'pm')?.name ?? ROLE_LABELS.pm) : ROLE_LABELS[role]
}
const authorName = (actor: Comment['author']) => actorName(actor, agentName)
const authorLabel = (actor: Comment['author']) => actorLabel(actor, agentName)
</script>

<template>
  <section class="flex min-h-0 flex-col">
    <AppTabs
      v-model="tab"
      :items="tabs"
      variant="link"
      :content="false"
    />
    <div
      v-if="tab === 'activity'"
      class="mt-3 flex flex-col gap-3"
    >
      <TaskActivityFeed
        :comments="comments"
        :runs="runs"
        :history="history"
        :author-name="authorName"
      />
      <DraftComposer
        :draft="draft"
        placeholder="Comment…"
        :hint="hint"
        :project="slug || null"
        :draft-key="`task:${taskRef}`"
        @submit="send"
      />
    </div>
    <div
      v-else-if="tab === 'evidence'"
      class="mt-3"
    >
      <EvidenceList
        :evidence="evidence"
        :criteria="task.acceptanceCriteria"
        :reviews="reviews"
      />
    </div>
    <TaskHistoryList
      v-else
      :history="history"
      :author-label="authorLabel"
    />
  </section>
</template>
