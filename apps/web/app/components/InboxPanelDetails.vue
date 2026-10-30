<script setup lang="ts">
import type { InboxPanel, InboxPanelContext } from '~/composables/useInboxPanel'
import { timeAgo } from '~/utils/labels'

// What every option hides by default: the full message, the criteria with
// the reviewer's notes and their evidence, and the review history
const props = withDefaults(defineProps<{ ctx: InboxPanelContext, p: InboxPanel, section?: 'all' | 'message' | 'criteria' | 'history' }>(), { section: 'all' })
const show = (s: 'message' | 'criteria' | 'history') => props.section === 'all' || props.section === s
</script>

<template>
  <div class="flex flex-col gap-5">
    <section v-if="show('message')">
      <h3
        v-if="section === 'all'"
        class="mb-2 text-xs font-medium text-muted"
      >
        Message from {{ ctx.item.sender.name }}
      </h3>
      <MarkdownText
        :text="ctx.item.body"
        class="text-sm"
      />
    </section>
    <section v-if="show('criteria') && ctx.item.type === 'human_review' && ctx.task">
      <h3
        v-if="section === 'all'"
        class="mb-2 text-xs font-medium text-muted"
      >
        Criteria, notes and evidence
      </h3>
      <EvidenceList
        :evidence="ctx.evidence"
        :criteria="ctx.task.acceptanceCriteria"
        :reviews="p.history.value"
      />
    </section>
    <section v-if="show('history') && p.history.value.length">
      <h3
        v-if="section === 'all'"
        class="mb-2 text-xs font-medium text-muted"
      >
        Review history
      </h3>
      <ol class="flex flex-col gap-3">
        <li
          v-for="r in p.history.value"
          :key="r.id"
          class="flex gap-2 text-sm"
        >
          <UIcon
            :name="r.verdict === 'approved' ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
            :class="['mt-0.5 size-4 shrink-0', r.verdict === 'approved' ? 'text-success' : 'text-warning']"
          />
          <div class="min-w-0 flex-1">
            <p class="text-xs text-muted">
              Round {{ r.round + 1 }} · {{ r.verdict === 'approved' ? 'Approved' : 'Changes requested' }} · {{ r.headSha.slice(0, 7) }} · {{ timeAgo(r.createdAt) }}
            </p>
            <MarkdownText :text="r.summary" />
          </div>
        </li>
      </ol>
    </section>
  </div>
</template>
