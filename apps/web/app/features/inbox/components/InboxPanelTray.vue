<script setup lang="ts">
import { useId } from 'vue'
import type { InboxComposerContext } from '~/features/inbox/composables/useInboxPanel'

// The panel's reply box. With no action chosen it replies to the sender; an
// action that opens the composer takes it over until it's sent or cancelled.
// A failed item opens on its Retry note, so replying there is a choice too.
const props = defineProps<{
  ctx: InboxComposerContext
  // Sends in place of ctx.submit, for a host that follows what's sent
  onSubmit?: (text: string) => Promise<boolean>
  // Offers Reply on a failed item, for a host with no Reply of its own
  offerReply?: boolean
}>()
const noteId = useId()
const retryNote = computed(() => props.ctx.item.type === 'failed' && props.ctx.action === 'resolve')
const composer = ref<{ focus: () => void, send: () => Promise<boolean>, uploading: boolean, hasImages: boolean } | null>(null)
const replying = computed(() => !!props.offerReply && props.ctx.item.type === 'failed' && props.ctx.action === null)
const chosen = computed(() => replying.value ? { label: 'Reply', icon: 'i-ri-reply-line' } : props.ctx.composerChosen ? props.ctx.actions.find(a => a.value === props.ctx.action) ?? null : null)
// Choosing an action focuses it; an item that opens with one chosen doesn't
watch(() => props.ctx.action, () => {
  if (chosen.value) void nextTick(() => composer.value?.focus())
})
// One-click actions use the same attachment-aware send as the reply button.
// Keep the action pending until any images the human picked have uploaded.
let cancelWait: (() => void) | undefined
onBeforeUnmount(() => cancelWait?.())
async function send() {
  if (composer.value?.uploading) {
    await new Promise<void>((resolve) => {
      const stop = watch(() => composer.value?.uploading, (uploading) => {
        if (!uploading) {
          stop()
          resolve()
        }
      })
      cancelWait = () => {
        stop()
        resolve()
      }
    })
    cancelWait = undefined
  }
  await nextTick()
  return await composer.value?.send() ?? false
}
defineExpose({ send, hasImages: computed(() => composer.value?.hasImages ?? false), focus: () => composer.value?.focus() })
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      v-if="chosen"
      class="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <Icon
        :name="chosen.icon"
        class="size-3.5"
      />
      <span>{{ chosen.label }}</span>
      <AppButton
        label="Cancel"
        variant="link"
        color="neutral"
        size="xs"
        @click="ctx.cancelAction()"
      />
    </div>
    <AppAlert
      v-if="ctx.actionError"
      color="error"
      variant="subtle"
      :title="ctx.actionError"
    />
    <div
      v-if="retryNote"
      class="flex items-center justify-between gap-2"
    >
      <label
        :for="noteId"
        class="text-sm font-medium text-foreground"
      >
        Note to send with Retry (optional)
      </label>
      <AppButton
        v-if="offerReply"
        label="Reply instead"
        variant="link"
        color="neutral"
        size="xs"
        :disabled="ctx.taskLoading"
        @click="ctx.setAction(null)"
      />
    </div>
    <p
      v-if="retryNote"
      class="text-xs text-muted-foreground"
    >
      Your note will guide the agent’s next run. Leave it empty to retry as is.
    </p>
    <PromptComposer
      ref="composer"
      :model-value="ctx.text"
      :input-id="retryNote ? noteId : undefined"
      :placeholder="retryNote ? 'What should the agent do differently?' : ctx.placeholder"
      :submit-label="ctx.submitLabel"
      :submit-color="ctx.action === 'delete' ? 'error' : 'primary'"
      :allow-empty="ctx.action !== null && !ctx.needsText"
      :busy="ctx.busy || ctx.taskLoading"
      :rows="1"
      :project="ctx.item.project.slug"
      :draft-key="ctx.draftKey"
      :on-submit="onSubmit ?? ctx.submit"
      @update:model-value="ctx.setText"
    />
  </div>
</template>
