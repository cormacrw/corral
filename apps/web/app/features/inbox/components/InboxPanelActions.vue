<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import { actionDisabled, type InboxComposerContext, type ResolveTo } from '~/features/inbox/composables/useInboxPanel'
import { RESOLVE_TARGETS } from '~/features/inbox/utils/inbox-actions'

// The item's actions as buttons
const props = defineProps<{ ctx: InboxComposerContext, canAct: boolean }>()
const primary = computed(() => props.canAct ? props.ctx.actions[0] ?? null : null)
const secondary = computed(() => props.canAct ? props.ctx.actions.slice(1) : [])
const act = (value: string) => props.ctx.act(value as InboxActionInput['action'])
</script>

<template>
  <div
    v-if="primary"
    class="flex flex-wrap items-center gap-2"
    data-testid="inbox-actions"
  >
    <AppButton
      :label="primary.label"
      :icon="primary.icon"
      size="sm"
      :loading="ctx.busy && ctx.action === primary.value"
      :disabled="actionDisabled(ctx, primary.value)"
      data-testid="inbox-primary"
      @click="act(primary.value)"
    />
    <AppSelectMenu
      v-if="primary.value === 'resolve'"
      :model-value="ctx.resolveTo"
      :items="RESOLVE_TARGETS"
      aria-label="Retry into"
      class="w-32"
      @update:model-value="ctx.setResolveTo($event as ResolveTo)"
    />
    <AppButton
      v-for="a in secondary"
      :key="a.value"
      :label="a.label"
      :icon="a.icon"
      size="sm"
      :loading="ctx.busy && ctx.action === a.value"
      :disabled="actionDisabled(ctx, a.value)"
      :color="a.value === 'delete' ? 'error' : 'neutral'"
      :variant="ctx.action === a.value ? 'subtle' : 'outline'"
      @click="act(a.value)"
    />
  </div>
</template>
