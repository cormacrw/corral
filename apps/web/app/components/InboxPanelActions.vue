<script setup lang="ts">
import type { InboxActionInput } from '@corral/contracts'
import type { InboxPanel, InboxPanelContext } from '~/composables/useInboxPanel'

// The item's actions as buttons: the primary one is a single click
withDefaults(defineProps<{ ctx: InboxPanelContext, p: InboxPanel, size?: 'sm' | 'md' | 'lg' | 'xl', block?: boolean, secondary?: boolean }>(), { size: 'sm', block: false, secondary: true })
</script>

<template>
  <div
    v-if="p.primary.value"
    :class="['flex gap-2', block ? 'w-full' : 'flex-wrap items-center']"
  >
    <UButton
      :label="p.primaryLabel.value"
      :icon="p.primary.value.icon"
      :size="size"
      :loading="ctx.busy && ctx.action === p.primary.value.value"
      :block="block"
      data-testid="inbox-primary"
      @click="ctx.act(p.primary.value.value as InboxActionInput['action'])"
    />
    <template v-if="secondary">
      <UButton
        v-for="a in p.secondary.value"
        :key="a.value"
        :label="a.label"
        :icon="a.icon"
        :size="size"
        :block="block"
        :color="a.value === 'delete' ? 'error' : 'neutral'"
        :variant="ctx.action === a.value ? 'subtle' : 'outline'"
        @click="ctx.act(a.value as InboxActionInput['action'])"
      />
    </template>
  </div>
</template>
