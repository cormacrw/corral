<script setup lang="ts">
import type { InboxPanel, InboxPanelContext } from '~/composables/useInboxPanel'
import { timeAgo } from '~/utils/labels'

// What the panel keeps a click away, one tab at a time: the criteria with their
// notes and evidence, the review history and the full message
const props = defineProps<{ ctx: InboxPanelContext, p: InboxPanel, section: 'criteria' | 'review' | 'message' }>()
const reviews = computed(() => props.p.history.value)
</script>

<template>
  <EvidenceList
    v-if="section === 'criteria'"
    :checked="ctx.checkedHumanCriteria"
    :evidence="ctx.evidence"
    :human-checklist="p.canAct.value"
    :criteria="p.criteria.value"
    :reviews="reviews"
    @update:checked="ctx.setCheckedHumanCriteria"
  />
  <ol
    v-else-if="section === 'review'"
    class="flex flex-col gap-3"
  >
    <li
      v-for="r in reviews"
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
  <MarkdownText
    v-else
    :text="ctx.item.body"
    class="text-sm"
  />
</template>
