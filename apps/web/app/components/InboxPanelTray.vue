<script setup lang="ts">
import { actionOpensComposer, type InboxPanelContext } from '~/composables/useInboxPanel'

// The panel's reply box. With no action chosen it replies to the sender; an
// action that opens the composer takes it over until it's sent or cancelled.
const props = defineProps<{ ctx: InboxPanelContext }>()
const composer = ref<{ focus: () => void } | null>(null)
const chosen = computed(() => props.ctx.action && actionOpensComposer(props.ctx.action) ? props.ctx.actions.find(a => a.value === props.ctx.action) ?? null : null)
watch(chosen, (value) => {
  if (value) void nextTick(() => composer.value?.focus())
})
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
      @submit="ctx.submit"
    />
  </div>
</template>
