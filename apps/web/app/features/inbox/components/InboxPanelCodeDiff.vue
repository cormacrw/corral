<script setup lang="ts">
import type { PullRequestDetail, Task } from '@corral/contracts'
import { usePullRequestGuide } from '~/features/inbox/composables/usePullRequestGuide'
import InboxPanelGuide from '~/features/inbox/components/InboxPanelGuide.vue'

// The Code diff tab with guided review (COR-518, design, recommended option B):
// the same hunks two ways. Guided tells the change as ordered steps; Files is
// the raw diff, file by file. A hunk's "In Files" opens its file there, and
// the tab opens on Guided once a guide exists, on Files until then.
const props = defineProps<{ pr: PullRequestDetail, slug: string, taskRef: string, criteria: Task['acceptanceCriteria'], mobile?: boolean }>()
const g = usePullRequestGuide(props.slug, props.taskRef, () => props.pr, () => props.criteria)
const mode = ref<'guided' | 'files' | null>(null)
const shown = computed(() => mode.value ?? (g.status.value === 'none' || g.status.value === 'loading' ? 'files' : 'guided'))
const focus = ref<string | null>(null)
const openFile = (path: string) => {
  focus.value = null
  mode.value = 'files'
  void nextTick(() => {
    focus.value = path || null
  })
}
const modes = computed(() => [
  { label: g.status.value === 'ready' && g.steps.value.length > 1 ? `Guided ${g.readCount.value}/${g.steps.value.length}` : 'Guided', value: 'guided', icon: 'i-hugeicons-route-02' },
  { label: 'Files', value: 'files', icon: 'i-hugeicons-source-code' }
])
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- The switch stays in view while you scroll, so Files is always one tap away -->
    <div :class="['sticky z-20 flex items-center gap-2 bg-background pb-1', mobile ? '-top-3 -mt-3 pt-3' : '-top-5 -mt-5 pt-5']">
      <AppTabs
        :model-value="shown"
        :items="modes"
        :content="false"
        data-testid="inbox-code-mode"
        @update:model-value="mode = $event as 'guided' | 'files'"
      />
      <span
        v-if="shown === 'files' && g.status.value === 'none'"
        class="min-w-0 truncate text-xs text-muted-foreground"
      >Guided reads it as steps</span>
    </div>
    <InboxPanelGuide
      v-if="shown === 'guided'"
      :g="g"
      :pr="pr"
      :mobile="mobile"
      @open-file="openFile"
    />
    <InboxPanelDiff
      v-else
      :pr="pr"
      :focus="focus"
    />
  </div>
</template>
