<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { cn } from 'cn'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'

export interface TabItem {
  label?: string
  value?: string | number
  icon?: string
  slot?: string
  disabled?: boolean
  badge?: string | number
  [key: string]: unknown
}

const props = withDefaults(defineProps<{
  items: readonly TabItem[]
  content?: boolean
  variant?: 'pill' | 'link'
  listClass?: HTMLAttributes['class']
  triggerClass?: HTMLAttributes['class']
  class?: HTMLAttributes['class']
}>(), { content: true, variant: 'pill', listClass: undefined, triggerClass: undefined, class: undefined })
const model = defineModel<string | number>()

const tabs = computed(() => props.items.map((item, index) => ({ ...item, key: String(item.value ?? index) })))
const value = computed(() => model.value === undefined ? tabs.value[0]?.key : String(model.value))
// Keeps a numeric model numeric, as its item declared it
function select(key: string | number) {
  const tab = tabs.value.find(t => t.key === String(key))
  model.value = tab?.value ?? key
}
</script>

<template>
  <Tabs
    :model-value="value"
    :class="cn('min-w-0', props.class)"
    @update:model-value="select"
  >
    <TabsList
      :variant="variant === 'link' ? 'line' : 'default'"
      :class="listClass"
    >
      <TabsTrigger
        v-for="tab in tabs"
        :key="tab.key"
        :value="tab.key"
        :disabled="tab.disabled"
        :class="triggerClass"
      >
        <Icon
          v-if="tab.icon"
          :name="tab.icon"
        />
        {{ tab.label }}
        <AppBadge
          v-if="tab.badge !== undefined"
          :label="tab.badge"
          color="neutral"
          variant="soft"
          size="sm"
        />
        <slot
          name="trailing"
          :item="tab as TabItem"
        />
      </TabsTrigger>
    </TabsList>
    <template v-if="content">
      <TabsContent
        v-for="tab in tabs"
        :key="tab.key"
        :value="tab.key"
      >
        <slot
          :name="tab.slot ?? tab.key"
          :item="tab as TabItem"
        />
      </TabsContent>
    </template>
  </Tabs>
</template>
