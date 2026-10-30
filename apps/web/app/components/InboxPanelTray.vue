<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import type { InboxPanelContext } from '~/composables/useInboxPanel'

// The panel's reply box: the chosen action (if any), its
// resolve target, errors and the composer. With chips, the quick actions too.
const props = withDefaults(defineProps<{ ctx: InboxPanelContext, chips?: boolean }>(), { chips: false })
const composer = ref<{ focus: () => void } | null>(null)
const chosen = computed(() => props.ctx.actions.find(a => a.value === props.ctx.action) ?? null)
watch(() => props.ctx.action, (value) => {
  if (value === 'request_changes' || value === 'clarify') void nextTick(() => composer.value?.focus())
})
defineExpose({ focus: () => composer.value?.focus() })
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      v-if="chips"
      role="radiogroup"
      aria-label="Quick actions"
      class="flex flex-wrap gap-1.5"
    >
      <UButton
        v-for="a in ctx.actions"
        :key="a.value"
        :label="a.label"
        :icon="a.icon"
        size="xs"
        role="radio"
        :aria-checked="ctx.action === a.value"
        :variant="ctx.action === a.value ? 'subtle' : 'outline'"
        :color="a.value === 'delete' ? 'error' : ctx.action === a.value ? 'primary' : 'neutral'"
        @click="ctx.setAction(ctx.action === a.value ? null : (a.value as InboxActionInput['action']))"
      />
    </div>
    <div
      v-else-if="chosen"
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
    <USelectMenu
      v-if="ctx.action === 'resolve'"
      :model-value="ctx.resolveTo"
      :items="[{ label: 'In progress', value: 'in_progress' }, { label: 'Ready', value: 'ready' }, { label: 'Backlog', value: 'backlog' }]"
      value-key="value"
      size="xs"
      :search-input="false"
      class="w-40"
      @update:model-value="ctx.setResolveTo($event as 'backlog' | 'ready' | 'in_progress')"
    />
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
      :busy="ctx.busy"
      :rows="1"
      :project="ctx.item.project.slug"
      @update:model-value="ctx.setText"
      @submit="ctx.submit"
    />
  </div>
</template>
