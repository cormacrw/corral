<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import { actionNeedsText, type InboxPanel, type InboxPanelContext } from '~/composables/useInboxPanel'

// Option D on a phone (COR-190 v3): every action as a large touch target in
// a bar at the bottom of the screen, within thumb reach. Actions that need
// words (Request changes, Clarify) and Reply open the composer just above
// the bar; the others are sent on the tap.
const props = defineProps<{ ctx: InboxPanelContext, p: InboxPanel }>()
const replying = ref(false)
watch(() => props.ctx.item.id, () => {
  replying.value = false
})
const composing = computed(() => replying.value || (props.ctx.action !== null && actionNeedsText(props.ctx.action)))
const SHORT: Record<string, string> = {
  approve: 'Approve and merge',
  request_changes: 'Request changes',
  clarify: 'Answer',
  send_back: 'Send back',
  delete: 'Delete',
  resolve: 'Retry'
}
const label = (a: { value: string, label: string }) => a.value === 'approve' && props.p.isDesign.value ? 'Approve design' : SHORT[a.value] ?? a.label
function tap(value: string) {
  replying.value = false
  void props.ctx.act(value as InboxActionInput['action'])
}
function reply() {
  props.ctx.setAction(null)
  replying.value = !replying.value
}
</script>

<template>
  <div
    class="shrink-0 border-t border-default bg-default pb-[env(safe-area-inset-bottom)]"
    data-testid="inbox-thumb-bar"
  >
    <div
      v-if="composing"
      class="border-b border-default p-3"
    >
      <InboxPanelTray :ctx="ctx" />
    </div>
    <UAlert
      v-else-if="ctx.actionError"
      color="error"
      variant="subtle"
      :title="ctx.actionError"
      class="m-3 mb-0"
    />
    <div class="flex gap-2 p-2">
      <button
        v-for="(a, i) in ctx.actions"
        :key="a.value"
        type="button"
        :class="[
          'flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-sm font-medium transition-colors disabled:opacity-60',
          i === 0 ? 'bg-primary text-inverted active:bg-primary/80'
          : a.value === 'delete' ? 'border border-default text-error active:bg-error/10'
            : ctx.action === a.value ? 'border border-primary bg-primary/10 text-primary' : 'border border-default text-default active:bg-elevated'
        ]"
        :disabled="ctx.busy"
        :data-testid="i === 0 ? 'inbox-primary' : undefined"
        @click="tap(a.value)"
      >
        <UIcon
          :name="ctx.busy && ctx.action === a.value ? 'i-lucide-loader-circle' : a.icon"
          :class="['size-5', ctx.busy && ctx.action === a.value && 'animate-spin']"
        />
        <span class="line-clamp-2 text-center leading-tight">{{ label(a) }}</span>
      </button>
      <button
        type="button"
        :class="['flex min-h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border text-sm font-medium', replying ? 'border-primary bg-primary/10 text-primary' : 'border-default text-muted active:bg-elevated']"
        :aria-pressed="replying"
        @click="reply"
      >
        <UIcon
          name="i-lucide-reply"
          class="size-5"
        />
        <span>Reply</span>
      </button>
    </div>
  </div>
</template>
