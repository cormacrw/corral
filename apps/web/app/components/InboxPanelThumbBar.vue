<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import { actionDisabled, actionOpensComposer, type InboxPanelContext, type ResolveTo } from '~/composables/useInboxPanel'

// The panel's actions on a phone (design/mobile.md): each one a large target at
// the bottom of the screen, in thumb reach. The composer opens just above them.
// Keep drafts visible so a one-tap action cannot send an unseen note or image.
const props = withDefaults(defineProps<{ ctx: InboxPanelContext, approveLabel?: string, reply?: boolean }>(), { approveLabel: undefined, reply: true })
const tray = ref<{ focus: () => void, send: () => Promise<boolean>, hasImages: boolean } | null>(null)
defineExpose({ send: () => tray.value?.send() ?? Promise.resolve(false) })

const replying = ref(false)
const composing = computed(() => replying.value || props.ctx.composerChosen || !!props.ctx.text.trim() || !!tray.value?.hasImages)
const SHORT: Record<string, string> = { send_back: 'Send back', delete: 'Delete' }
const label = (a: { value: string, label: string }) => a.value === 'approve' && props.approveLabel && !props.ctx.taskLoading && !props.ctx.taskLoadFailed ? props.approveLabel : SHORT[a.value] ?? a.label
function tap(value: string) {
  replying.value = false
  const action = value as InboxActionInput['action']
  void props.ctx.act(action)
  // Already chosen on a question, so the tray has no change to focus on
  if (actionOpensComposer(action)) void nextTick(() => tray.value?.focus())
}
function toggleReply() {
  props.ctx.setAction(null)
  replying.value = !replying.value
  if (replying.value) void nextTick(() => tray.value?.focus())
}
async function submit(text: string) {
  const sent = await props.ctx.submit(text)
  if (sent) replying.value = false
  return sent
}
</script>

<template>
  <div
    class="shrink-0 border-t border-default bg-default pb-[env(safe-area-inset-bottom)]"
    data-testid="inbox-thumb-bar"
  >
    <div
      v-show="composing"
      class="border-b border-default p-3"
    >
      <InboxPanelTray
        ref="tray"
        :ctx="ctx"
        :on-submit="submit"
      />
    </div>
    <UAlert
      v-if="ctx.actionError && !composing"
      color="error"
      variant="subtle"
      :title="ctx.actionError"
      class="mx-3 mt-3 w-auto"
    />
    <div
      v-if="ctx.actions[0]?.value === 'resolve'"
      class="flex items-center justify-between gap-2 px-3 pt-3 text-sm text-muted"
    >
      <span>Retry into</span>
      <USelectMenu
        :model-value="ctx.resolveTo"
        :items="[{ label: 'In progress', value: 'in_progress' }, { label: 'Ready', value: 'ready' }, { label: 'Backlog', value: 'backlog' }]"
        value-key="value"
        :search-input="false"
        aria-label="Retry into"
        class="w-36"
        @update:model-value="ctx.setResolveTo($event as ResolveTo)"
      />
    </div>
    <div class="flex gap-2 p-2">
      <button
        v-for="(a, i) in ctx.actions"
        :key="a.value"
        type="button"
        :class="[
          'flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60',
          i === 0 ? 'bg-primary text-inverted active:bg-primary/80'
          : a.value === 'delete' ? ['border text-error active:bg-error/10', ctx.action === a.value ? 'border-error bg-error/10' : 'border-default']
            : ctx.action === a.value ? 'border border-primary bg-primary/10 text-primary' : 'border border-default text-default active:bg-elevated'
        ]"
        :aria-label="a.label"
        :disabled="actionDisabled(ctx, a.value)"
        :data-testid="i === 0 ? 'inbox-primary' : undefined"
        @click="tap(a.value)"
      >
        <UIcon
          :name="ctx.busy && ctx.action === a.value ? 'i-lucide-loader-circle' : a.icon"
          :class="['size-5 shrink-0', ctx.busy && ctx.action === a.value && 'animate-spin']"
        />
        <span class="line-clamp-2 text-center leading-tight">{{ label(a) }}</span>
      </button>
      <button
        v-if="reply"
        type="button"
        :class="['flex min-h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border text-sm font-medium', replying ? 'border-primary bg-primary/10 text-primary' : 'border-default text-muted active:bg-elevated']"
        :aria-pressed="replying"
        @click="toggleReply"
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
