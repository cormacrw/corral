<script setup lang="ts">
import type { PullRequestDetail, Task } from '@corral/contracts'
import { useElementSize } from '@vueuse/core'
import { usePullRequestGuide } from '~/features/inbox/composables/usePullRequestGuide'
import InboxPanelGuide from '~/features/inbox/components/InboxPanelGuide.vue'

// The Code diff tab with guided review (COR-525, design COR-518 option B): the
// same hunks two ways. Guided tells the change as ordered steps; Files is the
// raw diff, file by file. A hunk's "In Files" opens its file there. The tab
// opens on Guided once a guide exists or is being made, on Files until then,
// and the choice holds while the item is open.
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
const select = (value: string | number | undefined) => {
  mode.value = value === 'files' ? 'files' : 'guided'
  if (mode.value === 'guided') focus.value = null
}
const modes = computed(() => [
  { label: g.status.value === 'ready' && g.steps.value.length > 1 ? `Guided ${g.readCount.value}/${g.steps.value.length}` : 'Guided', value: 'guided', icon: 'i-hugeicons-route-02' },
  { label: 'Files', value: 'files', icon: 'i-hugeicons-source-code' }
])

// The switch sticks above the scroller's padding, so it covers what scrolls
// under it. The open step's header sticks right where the switch ends, a pixel
// under it, so no diff line shows through between them.
const bar = ref<HTMLElement | null>(null)
const { height } = useElementSize(bar, undefined, { box: 'border-box' })
const pad = computed(() => props.mobile ? 12 : 20)
const headTop = computed(() => `${Math.max(0, Math.floor(height.value) - pad.value - 1)}px`)
</script>

<template>
  <div
    class="flex flex-col gap-3"
    :style="{ '--guide-head-top': headTop }"
  >
    <!-- Stays in view while you scroll, so Files is always one tap away -->
    <div
      ref="bar"
      data-guide-switch
      :class="['sticky z-20 flex items-center gap-2 bg-background pb-2', mobile ? '-top-3 -mt-3 pt-3' : '-top-5 -mt-5 pt-5']"
    >
      <AppTabs
        :model-value="shown"
        :items="modes"
        :content="false"
        data-testid="inbox-code-mode"
        @update:model-value="select"
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
