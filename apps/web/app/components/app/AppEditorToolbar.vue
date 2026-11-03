<script setup lang="ts">
import type { Editor } from '@tiptap/vue-3'

export interface Toggle {
  label: string
  icon: string
  // A TipTap mark or node to toggle; omit for a plain action
  kind?: 'bold' | 'italic' | 'code' | 'heading' | 'bulletList' | 'orderedList' | 'codeBlock' | 'link'
  onClick?: () => void
}

const props = defineProps<{ editor: Editor, tools: readonly (readonly Toggle[])[] }>()

function isActive(tool: Toggle) {
  if (!tool.kind) return false
  return tool.kind === 'heading' ? props.editor.isActive('heading', { level: 2 }) : props.editor.isActive(tool.kind)
}

function run(tool: Toggle) {
  if (tool.onClick) return tool.onClick()
  const chain = props.editor.chain().focus()
  if (tool.kind === 'bold') chain.toggleBold().run()
  else if (tool.kind === 'italic') chain.toggleItalic().run()
  else if (tool.kind === 'code') chain.toggleCode().run()
  else if (tool.kind === 'heading') chain.toggleHeading({ level: 2 }).run()
  else if (tool.kind === 'bulletList') chain.toggleBulletList().run()
  else if (tool.kind === 'orderedList') chain.toggleOrderedList().run()
  else if (tool.kind === 'codeBlock') chain.toggleCodeBlock().run()
  else if (tool.kind === 'link') toggleLink()
}

function toggleLink() {
  if (props.editor.isActive('link')) {
    props.editor.chain().focus().unsetLink().run()
    return
  }
  const href = window.prompt('Link URL')
  if (href) props.editor.chain().focus().setLink({ href }).run()
}
</script>

<template>
  <div
    role="toolbar"
    aria-label="Formatting"
    class="flex flex-wrap items-center gap-0.5"
  >
    <template
      v-for="(group, index) in tools"
      :key="index"
    >
      <UiSeparator
        v-if="index > 0"
        orientation="vertical"
        class="mx-1 h-4"
      />
      <AppButton
        v-for="tool in group"
        :key="tool.label"
        :icon="tool.icon"
        :aria-label="tool.label"
        :aria-pressed="isActive(tool)"
        size="xs"
        variant="ghost"
        :color="isActive(tool) ? 'primary' : 'neutral'"
        @click="run(tool)"
      />
    </template>
  </div>
</template>
