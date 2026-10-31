<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import { actionOpensComposer, type InboxPanel, type InboxPanelContext } from '~/composables/useInboxPanel'

// The panel's actions on a phone: targets at least 64px tall at the bottom of
// the screen, plus Reply. What opens the composer opens it above the bar. It
// stays mounted while closed, so one tap sends through it like a click on
// desktop, and it stays open while it holds a draft that tap would send.
const props = defineProps<{ ctx: InboxPanelContext, p: InboxPanel }>()
const tray = ref<{ focus: () => void, send: () => Promise<boolean>, hasImages: boolean } | null>(null)
defineExpose({ send: () => tray.value?.send() ?? Promise.resolve(false) })

const SHORT: Record<string, string> = { send_back: 'Send back', delete: 'Delete' }
const replying = ref(false)
const chosen = computed(() => props.ctx.action !== null && actionOpensComposer(props.ctx.action))
const hasDraft = computed(() => props.ctx.text.trim().length > 0 || (tray.value?.hasImages ?? false))
const open = computed(() => replying.value || chosen.value || hasDraft.value)
const replyOpen = computed(() => open.value && !chosen.value)

function tap(value: string) {
  replying.value = false
  void props.ctx.act(value as InboxActionInput['action'])
}
function toggleReply() {
  replying.value = !replyOpen.value
  props.ctx.setAction(null)
  if (replying.value) void nextTick(() => tray.value?.focus())
}
</script>

<template>
  <div
    class="shrink-0 border-t border-default bg-default pb-[env(safe-area-inset-bottom)]"
    data-testid="inbox-thumb-bar"
  >
    <div
      v-show="open"
      class="border-b border-default p-3"
    >
      <InboxPanelTray
        ref="tray"
        :ctx="ctx"
        @sent="replying = false"
      />
    </div>
    <UAlert
      v-if="ctx.actionError && !open"
      color="error"
      variant="subtle"
      :title="ctx.actionError"
      class="m-3 mb-0 w-auto"
    />
    <div class="flex gap-2 p-2">
      <button
        v-for="(a, i) in ctx.actions"
        :key="a.value"
        type="button"
        :class="[
          'flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60',
          i === 0 ? 'bg-primary text-inverted active:bg-primary/80'
          : a.value === 'delete' ? 'border border-default text-error active:bg-error/10'
            : ctx.action === a.value ? 'border border-primary bg-primary/10 text-primary' : 'border border-default text-default active:bg-elevated'
        ]"
        :aria-label="a.label"
        :disabled="p.actionDisabled(a.value)"
        :data-testid="i === 0 ? 'inbox-primary' : undefined"
        @click="tap(a.value)"
      >
        <UIcon
          :name="ctx.busy && ctx.action === a.value ? 'i-lucide-loader-circle' : a.icon"
          :class="['size-5 shrink-0', ctx.busy && ctx.action === a.value && 'animate-spin']"
        />
        <span class="line-clamp-2 text-center leading-tight">{{ SHORT[a.value] ?? a.label }}</span>
      </button>
      <button
        type="button"
        :class="['flex min-h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary', replyOpen ? 'border-primary bg-primary/10 text-primary' : 'border-default text-muted active:bg-elevated']"
        :aria-pressed="replyOpen"
        data-testid="inbox-reply"
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
