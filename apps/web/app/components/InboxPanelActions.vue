<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import { actionDisabled, type InboxPanel, type InboxPanelContext, type ResolveTo } from '~/composables/useInboxPanel'

// The item's actions as buttons
const props = defineProps<{ ctx: InboxPanelContext, p: InboxPanel }>()
const act = (value: string) => props.ctx.act(value as InboxActionInput['action'])
</script>

<template>
  <div
    v-if="p.primary.value"
    class="flex flex-wrap items-center gap-2"
    data-testid="inbox-actions"
  >
    <UButton
      :label="p.primary.value.label"
      :icon="p.primary.value.icon"
      size="sm"
      :loading="ctx.busy && ctx.action === p.primary.value.value"
      :disabled="actionDisabled(ctx, p.primary.value.value)"
      data-testid="inbox-primary"
      @click="act(p.primary.value.value)"
    />
    <USelectMenu
      v-if="p.primary.value.value === 'resolve'"
      :model-value="ctx.resolveTo"
      :items="[{ label: 'In progress', value: 'in_progress' }, { label: 'Ready', value: 'ready' }, { label: 'Backlog', value: 'backlog' }]"
      value-key="value"
      size="sm"
      :search-input="false"
      aria-label="Retry into"
      class="w-32"
      @update:model-value="ctx.setResolveTo($event as ResolveTo)"
    />
    <UButton
      v-for="a in p.secondary.value"
      :key="a.value"
      :label="a.label"
      :icon="a.icon"
      size="sm"
      :disabled="actionDisabled(ctx, a.value)"
      :color="a.value === 'delete' ? 'error' : 'neutral'"
      :variant="ctx.action === a.value ? 'subtle' : 'outline'"
      @click="act(a.value)"
    />
  </div>
</template>
