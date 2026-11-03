<script setup lang="ts">
import type { Extensions } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import type { Toggle } from './AppEditorToolbar.vue'

// A TipTap document editor bound to JSON, with its toolbar.
const props = defineProps<{
  modelValue: unknown
  extensions?: Extensions
  editorProps?: Record<string, unknown>
  placeholder?: string
  contentClass?: string
  tools?: readonly (readonly Toggle[])[]
}>()
const emit = defineEmits<{ 'update:modelValue': [doc: unknown] }>()

const editor = useEditor({
  content: props.modelValue as never,
  autofocus: 'end',
  extensions: [StarterKit, Placeholder.configure({ placeholder: props.placeholder }), ...(props.extensions ?? [])],
  editorProps: { ...props.editorProps, attributes: { class: `outline-none ${props.contentClass ?? ''}` } },
  onUpdate: ({ editor }) => emit('update:modelValue', editor.getJSON())
})
defineExpose({ editor, view: (): EditorView | undefined => editor.value?.view })
</script>

<template>
  <div>
    <AppEditorToolbar
      v-if="editor && tools"
      :editor="editor"
      :tools="tools"
      class="border-b px-1 py-1"
    />
    <EditorContent :editor="editor" />
  </div>
</template>

<style>
.ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
  color: var(--muted-foreground);
}
</style>
