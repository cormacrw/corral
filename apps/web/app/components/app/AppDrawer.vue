<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from '~/components/ui/drawer'

// A bottom sheet. The default slot is an optional trigger. Fill #content for a
// custom sheet, or #body and #footer to match AppModal, with a visible header.
const props = withDefaults(defineProps<{
  title: string
  description?: string
  contentClass?: HTMLAttributes['class']
  dismissible?: boolean
}>(), { description: undefined, contentClass: undefined, dismissible: true })
const open = defineModel<boolean>('open', { default: false })

function setOpen(next: boolean) {
  if (next || props.dismissible) open.value = next
}
</script>

<template>
  <Drawer
    :open="open"
    @update:open="setOpen"
  >
    <DrawerTrigger
      v-if="$slots.default"
      as-child
    >
      <slot />
    </DrawerTrigger>
    <DrawerContent :class="contentClass">
      <DrawerHeader :class="{ 'sr-only': !$slots.body }">
        <DrawerTitle>{{ title }}</DrawerTitle>
        <DrawerDescription>{{ description || title }}</DrawerDescription>
      </DrawerHeader>
      <slot name="content">
        <div
          v-if="$slots.body"
          class="min-h-0 overflow-y-auto px-4 pb-4"
        >
          <slot name="body" />
        </div>
        <DrawerFooter v-if="$slots.footer">
          <slot name="footer" />
        </DrawerFooter>
      </slot>
    </DrawerContent>
  </Drawer>
</template>
