<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import { actionDisabled, actionOpensComposer, type InboxComposerContext, type ResolveTo } from '~/features/inbox/composables/useInboxPanel'
import { RESOLVE_TARGETS } from '~/features/inbox/utils/inbox-actions'

// The panel's actions on a phone (design/mobile.md): each one a large target at
// the bottom of the screen, in thumb reach. The composer opens just above them.
// Keep drafts visible so a one-tap action cannot send an unseen note or image.
const props = withDefaults(defineProps<{ ctx: InboxComposerContext, approveLabel?: string, reply?: boolean }>(), { approveLabel: undefined, reply: true })
const tray = ref<{ focus: () => void, send: () => Promise<boolean>, hasImages: boolean } | null>(null)
defineExpose({ send: () => tray.value?.send() ?? Promise.resolve(false) })

const replying = ref(false)
const composing = computed(() => props.ctx.item.type === 'failed' || replying.value || props.ctx.composerChosen || !!props.ctx.text.trim() || !!tray.value?.hasImages)
const SHORT: Record<string, string> = { send_back: 'Send back', delete: 'Delete' }
const label = (a: { value: string, label: string }) => a.value === 'approve' && props.approveLabel && !props.ctx.taskLoading && !props.ctx.taskLoadFailed ? props.approveLabel : SHORT[a.value] ?? a.label
// Reply ends when anything picks an action, such as the item's default
watch(() => props.ctx.action, (action) => {
  if (action) replying.value = false
})
function tap(value: string) {
  replying.value = false
  const action = value as InboxActionInput['action']
  void props.ctx.act(action)
  // Already chosen on a question, so the tray has no change to focus on
  if (actionOpensComposer(action)) void nextTick(() => tray.value?.focus())
}
function toggleReply() {
  replying.value = !replying.value
  if (!replying.value) return props.ctx.cancelAction()
  props.ctx.setAction(null)
  void nextTick(() => tray.value?.focus())
}
async function submit(text: string) {
  const sent = await props.ctx.submit(text)
  if (sent) replying.value = false
  return sent
}
</script>

<template>
  <div
    class="shrink-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]"
    data-testid="inbox-thumb-bar"
  >
    <div
      v-show="composing"
      class="border-b border-border p-3"
    >
      <InboxPanelTray
        ref="tray"
        :ctx="ctx"
        :on-submit="submit"
      />
    </div>
    <AppAlert
      v-if="ctx.actionError && !composing"
      color="error"
      variant="subtle"
      :title="ctx.actionError"
      class="mx-3 mt-3 w-auto"
    />
    <div
      v-if="ctx.actions[0]?.value === 'resolve'"
      class="flex items-center justify-between gap-2 px-3 pt-3 text-sm text-muted-foreground"
    >
      <span>Retry into</span>
      <AppSelectMenu
        :model-value="ctx.resolveTo"
        :items="RESOLVE_TARGETS"
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
          i === 0 ? 'bg-primary text-primary-foreground active:bg-primary/80'
          : a.value === 'delete' ? ['border text-destructive active:bg-destructive/10', ctx.action === a.value ? 'border-destructive bg-destructive/10' : 'border-border']
            : ctx.action === a.value ? 'border border-primary bg-primary/10 text-brand' : 'border border-border text-foreground active:bg-muted'
        ]"
        :aria-label="a.label"
        :disabled="actionDisabled(ctx, a.value)"
        :data-testid="i === 0 ? 'inbox-primary' : undefined"
        @click="tap(a.value)"
      >
        <Icon
          :name="ctx.busy && ctx.action === a.value ? 'i-hugeicons-loading-03' : a.icon"
          :class="['size-5 shrink-0', ctx.busy && ctx.action === a.value && 'animate-spin']"
        />
        <span class="line-clamp-2 text-center leading-tight">{{ label(a) }}</span>
      </button>
      <button
        v-if="reply"
        type="button"
        :class="['flex min-h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border text-sm font-medium', replying ? 'border-primary bg-primary/10 text-brand' : 'border-border text-muted-foreground active:bg-muted']"
        :aria-pressed="replying"
        @click="toggleReply"
      >
        <Icon
          name="i-hugeicons-arrow-turn-backward"
          class="size-5"
        />
        <span>Reply</span>
      </button>
    </div>
  </div>
</template>
