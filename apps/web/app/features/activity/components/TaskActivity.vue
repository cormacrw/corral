<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import type { AuditEntry, Comment, Evidence, Review, Run, Task } from '@corral/contracts'
import { actorLabel } from '~/features/activity/utils/auditText'
import { ROLE } from '~/utils/labels'

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

// The task's runs say which agent acted
const authorLabel = (actor: Comment['author']) => actorLabel(actor, (agent) => {
  const run = props.runs.find(r => r.id === agent.runId)
  if (run) return run.agentName
  return agent.role === 'pm' ? (shell.agents.find(a => a.role === 'pm')?.name ?? ROLE.pm) : ROLE[agent.role]
})
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
        :author-label="authorLabel"
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
