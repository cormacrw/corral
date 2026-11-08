<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import { actionDisabled, actionOpensComposer, type InboxComposerContext, type ResolveTo } from '~/features/inbox/composables/useInboxPanel'
import { RETRY_TARGETS } from '~/features/inbox/utils/inbox-actions'

// The panel's actions on a phone (design/mobile.md): each one a large target at
// the bottom of the screen, in thumb reach. The composer opens just above them.
// Keep drafts visible so a one-tap action cannot send an unseen note or image.
const props = withDefaults(defineProps<{ ctx: InboxComposerContext, approveLabel?: string }>(), { approveLabel: undefined })
const tray = ref<{ focus: () => void, send: () => Promise<boolean>, hasImages: boolean } | null>(null)
defineExpose({ send: () => tray.value?.send() ?? Promise.resolve(false) })

const composing = computed(() => props.ctx.item.type === 'failed' || props.ctx.composerChosen || !!props.ctx.text.trim() || !!tray.value?.hasImages)
const SHORT: Record<string, string> = { send_back: 'Send back', delete: 'Delete' }
const label = (a: { value: string, label: string }) => a.value === 'approve' && props.approveLabel && !props.ctx.taskLoading && !props.ctx.taskLoadFailed ? props.approveLabel : SHORT[a.value] ?? a.label
function tap(value: string) {
  const action = value as InboxActionInput['action']
  void props.ctx.act(action)
  // Already chosen on a question, so the tray has no change to focus on
  if (actionOpensComposer(action)) void nextTick(() => tray.value?.focus())
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
        :items="RETRY_TARGETS"
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
    </div>
  </div>
</template>
