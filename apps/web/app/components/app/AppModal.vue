<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog'

const props = withDefaults(defineProps<{
  title?: string
  description?: string
  contentClass?: HTMLAttributes['class']
  dismissible?: boolean
}>(), { title: undefined, description: undefined, contentClass: undefined, dismissible: true })
const open = defineModel<boolean>('open', { default: false })

function setOpen(next: boolean) {
  if (next || props.dismissible) open.value = next
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="setOpen"
  >
    <DialogContent :class="contentClass">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription :class="{ 'sr-only': !description }">
          {{ description || title }}
        </DialogDescription>
      </DialogHeader>
      <slot name="body" />
      <DialogFooter v-if="$slots.footer">
        <slot name="footer" />
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
