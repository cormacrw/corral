<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import type { InboxPanel, InboxPanelContext } from '~/composables/useInboxPanel'

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
      :disabled="p.actionDisabled(p.primary.value.value)"
      data-testid="inbox-primary"
      @click="act(p.primary.value.value)"
    />
    <InboxPanelRetryInto
      v-if="p.primary.value.value === 'resolve'"
      :ctx="ctx"
      size="sm"
    />
    <UButton
      v-for="a in p.secondary.value"
      :key="a.value"
      :label="a.label"
      :icon="a.icon"
      size="sm"
      :disabled="p.actionDisabled(a.value)"
      :color="a.value === 'delete' ? 'error' : 'neutral'"
      :variant="ctx.action === a.value ? 'subtle' : 'outline'"
      @click="act(a.value)"
    />
  </div>
</template>
