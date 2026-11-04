<script setup lang="ts">
import { ref } from 'vue'
import type { TabItem } from '~/components/app/AppTabs.vue'

// The frame every panel shares (design/inbox.md, Option D): what's needed to
// decide up front, then tabs for the rest. On a phone (design/mobile.md) the
// footer is the bottom bar.
withDefaults(defineProps<{ tabs: readonly TabItem[], openTab: string, mobile?: boolean, as?: string, bodyClass?: string }>(), { as: 'div', bodyClass: undefined })
defineEmits<{ select: [value: string], scroll: [] }>()
// The body's scroller, for a panel that manages its own scroll position
const scroller = ref<HTMLElement | null>(null)
defineExpose({ scroller })
</script>

<template>
  <component
    :is="as"
    class="flex min-h-0 min-w-0 flex-1 flex-col"
  >
    <div :class="['flex max-h-[60%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-border', mobile ? 'p-3' : 'px-5 pt-4 pb-3']">
      <slot name="header" />
    </div>
    <!-- One tab has nothing to switch to -->
    <AppTabs
      v-if="tabs.length > 1"
      :model-value="openTab"
      :items="tabs"
      :content="false"
      variant="link"
      list-class="no-scrollbar max-w-full justify-start overflow-x-auto overflow-y-hidden pb-1"
      trigger-class="shrink-0"
      :class="['shrink-0', mobile ? 'px-1' : 'px-3']"
      data-testid="inbox-tabs"
      @update:model-value="$emit('select', String($event))"
    />
    <div
      ref="scroller"
      :class="['min-h-0 flex-1 overflow-y-auto overscroll-contain', mobile ? 'p-3' : 'p-5', bodyClass]"
      data-testid="inbox-detail-scroller"
      @scroll.passive="$emit('scroll')"
    >
      <slot />
    </div>
    <slot name="footer" />
  </component>
</template>
