<script setup lang="ts">
import { ref } from 'vue'
import type { TabItem } from '~/components/app/AppTabs.vue'
import type { InboxItemKind } from '~/utils/inbox-kinds'
import InboxPanelMeta, { type InboxMetaItem } from '~/features/inbox/components/InboxPanelMeta.vue'

// The frame every panel shares (design/inbox.md, Option D): the item's subject
// and what it is, what's needed to decide up front, then tabs for the rest. On
// a phone (design/mobile.md) the footer is the bottom bar. `titleTo` links the
// subject to its page.
withDefaults(defineProps<{
  item: InboxMetaItem & { subject: string }
  kind: InboxItemKind
  titleTo?: string
  tabs: readonly TabItem[]
  openTab: string
  mobile?: boolean
  as?: string
  bodyClass?: string
}>(), { as: 'div', bodyClass: undefined, titleTo: undefined })
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
      <div class="min-w-0">
        <h1 :class="['text-lg leading-tight font-semibold text-foreground', titleTo && 'break-words']">
          <NuxtLink
            v-if="titleTo"
            :to="titleTo"
            class="hover:underline"
          >
            {{ item.subject }}
          </NuxtLink>
          <template v-else>
            {{ item.subject }}
          </template>
        </h1>
        <InboxPanelMeta
          class="mt-1"
          :kind="kind"
          :item="item"
        />
      </div>
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
