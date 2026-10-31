<script setup lang="ts">
import type { InboxPanelContext } from '~/composables/useInboxPanel'

// The panel's reply box. With no action chosen it replies to the sender; an
// action that opens the composer takes it over until it's sent or cancelled.
const props = defineProps<{
  ctx: InboxPanelContext
  // Sends in place of ctx.submit, for a host that follows what's sent
  onSubmit?: (text: string) => Promise<boolean>
}>()
const composer = ref<{ focus: () => void, send: () => Promise<boolean>, uploading: boolean } | null>(null)
const chosen = computed(() => props.ctx.composerChosen ? props.ctx.actions.find(a => a.value === props.ctx.action) ?? null : null)
watch(chosen, (value) => {
  if (value) void nextTick(() => composer.value?.focus())
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
defineExpose({ send, focus: () => composer.value?.focus() })
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      v-if="chosen"
      class="flex items-center gap-2 text-xs text-muted"
    >
      <UIcon
        :name="chosen.icon"
        class="size-3.5"
      />
      <span>{{ chosen.label }}</span>
      <UButton
        label="Cancel"
        variant="link"
        color="neutral"
        size="xs"
        @click="ctx.setAction(null)"
      />
    </div>
    <UAlert
      v-if="ctx.actionError"
      color="error"
      variant="subtle"
      :title="ctx.actionError"
    />
    <PromptComposer
      ref="composer"
      :model-value="ctx.text"
      :placeholder="ctx.placeholder"
      :submit-label="ctx.submitLabel"
      :submit-color="ctx.action === 'delete' ? 'error' : 'primary'"
      :allow-empty="ctx.action !== null && !ctx.needsText"
      :busy="ctx.busy || ctx.taskLoading"
      :rows="1"
      :project="ctx.item.project.slug"
      @update:model-value="ctx.setText"
      :on-submit="onSubmit ?? ctx.submit"
    />
  </div>
</template>
