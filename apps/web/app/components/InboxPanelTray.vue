<script setup lang="ts">
import { actionOpensComposer, type InboxPanelContext } from '~/composables/useInboxPanel'

// The panel's reply box. With no action chosen it replies to the sender; an
// action that opens the composer takes it over until it's sent or cancelled.
const props = defineProps<{ ctx: InboxPanelContext }>()
const emit = defineEmits<{ sent: [] }>()
const composer = ref<{ focus: () => void, send: () => Promise<boolean>, uploading: boolean, hasImages: boolean } | null>(null)
const chosen = computed(() => props.ctx.action && actionOpensComposer(props.ctx.action) ? props.ctx.actions.find(a => a.value === props.ctx.action) ?? null : null)
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
async function submit(message: string) {
  const sent = await props.ctx.submit(message)
  if (sent) emit('sent')
  return sent
}
defineExpose({ send, focus: () => composer.value?.focus(), hasImages: computed(() => composer.value?.hasImages ?? false) })
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
      @submit="submit"
    />
  </div>
</template>
