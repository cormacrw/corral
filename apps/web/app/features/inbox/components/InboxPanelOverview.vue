<script setup lang="ts">
import type { Evidence } from '@corral/contracts'
import type { InboxPanel, InboxPanelContext } from '~/features/inbox/composables/useInboxPanel'
import { evidenceCriterion } from '~/features/evidence/utils/evidenceFile'
import InboxEvidenceCarousel from '~/features/inbox/components/InboxEvidenceCarousel.vue'

// The panel's Overview tab: a decision's options, a review's evidence, or what
// each action does when there's nothing else to show
const props = defineProps<{ ctx: InboxPanelContext, p: InboxPanel, mobile?: boolean }>()
const viewing = ref<Evidence | null>(null)

// Each captioned with the criterion it proves, in the carousel and the viewer
const criterionOf = (evidence: Evidence) => evidenceCriterion(evidence, props.p.task.value?.acceptanceCriteria ?? [])
const shots = computed(() => props.p.images.value.map(evidence => ({ evidence, caption: criterionOf(evidence) })))
// The viewer flips through every file here, screenshots first
const files = computed(() => [...props.p.images.value, ...props.p.others.value])
const captions = computed(() => Object.fromEntries(files.value.map(f => [f.id, criterionOf(f)])))
const hasEvidence = computed(() => props.p.images.value.length > 0 || props.p.others.value.length > 0)
// Approval can't be taken without its task, so there's nothing to explain
const actionHelp = computed(() => props.ctx.actions.filter(a => !(a.value === 'approve' && props.ctx.taskLoadFailed)))
const decisionItem = computed(() => {
  const { item } = props.ctx
  return 'decision' in item && item.decision ? { ...item, decision: item.decision } : null
})
const loading = computed(() => props.ctx.taskLoading || (props.p.isReview.value && props.ctx.evidenceLoading))
</script>

<template>
  <div
    v-if="loading"
    :class="['grid gap-2', mobile ? 'grid-cols-2' : 'grid-cols-3']"
    data-testid="inbox-overview-loading"
  >
    <UiSkeleton
      v-for="i in 3"
      :key="i"
      class="aspect-video w-full"
    />
  </div>
  <div
    v-else
    class="flex flex-col gap-4"
  >
    <InboxEpicDecision
      v-if="decisionItem && p.canAct.value"
      :item="decisionItem"
    />
    <p
      v-if="!p.canAct.value"
      class="text-sm text-muted-foreground"
      data-testid="inbox-read-only"
    >
      {{ p.readOnlyNote.value }}
    </p>
    <InboxEvidenceCarousel
      v-if="p.isReview.value && shots.length"
      :shots="shots"
      :current="viewing?.id"
      @open="viewing = $event"
    />
    <div
      v-if="p.isReview.value && p.others.value.length"
      class="flex flex-wrap items-center gap-2"
    >
      <AppButton
        v-for="e in p.others.value"
        :key="e.id"
        :icon="e.contentType?.startsWith('video/') ? 'i-hugeicons-video-01' : 'i-hugeicons-file-01'"
        color="neutral"
        variant="ghost"
        size="xs"
        class="max-w-48"
        @click="viewing = e"
      >
        <span class="truncate">{{ e.fileName ?? 'File' }}</span>
      </AppButton>
    </div>
    <ul
      v-if="p.canAct.value && !(p.isReview.value && hasEvidence)"
      class="flex flex-col gap-2 text-sm"
      data-testid="inbox-action-help"
    >
      <li
        v-for="a in actionHelp"
        :key="a.value"
        class="flex items-center gap-2"
      >
        <Icon
          :name="a.icon"
          class="size-4 shrink-0 text-muted-foreground"
        />
        <span class="font-medium">{{ a.label }}</span>
        <span class="text-muted-foreground">{{ p.explanations.value[a.value] }}</span>
      </li>
    </ul>
    <EvidenceViewer
      v-model="viewing"
      :files="files"
      :captions="captions"
    />
  </div>
</template>
