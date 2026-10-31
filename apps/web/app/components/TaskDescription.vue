<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { EditorToolbarItem } from '@nuxt/ui'
import type { EditorView } from '@tiptap/pm/view'
import { uploadAttachment } from '~/queries/attachments'
import { attachmentProblem } from '~/utils/attachments'
import { AttachmentImage, imageFiles, insertImages } from '~/utils/editor-image'

// A task's description, read or edited. Its own chunk, since the editor is the
// largest thing on the page. The read-only view is the editor too: documents
// keep extension fields a hand-written renderer wouldn't draw the same way.
const props = defineProps<{ doc: unknown, editing?: boolean, slug?: string }>()
const emit = defineEmits<{ 'update:doc': [doc: { type: 'doc', content?: never[] }], 'cancel': [] }>()
const uploading = defineModel<number>('uploading', { default: 0 })

const toast = useToast()
const uploadMutation = useMutation(uploadAttachment)
// The editor's defaults suit a full page; a task's description sits in a
// narrow column at body text size
const descriptionUi = {
  base: 'text-sm sm:px-0 *:my-2 [&_p]:leading-6 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h2>code]:text-sm [&_h3>code]:text-sm [&_li]:my-0.5 [&_pre]:px-3 [&_pre]:py-2 [&_pre]:text-xs/5 [&_code]:text-xs [&_img]:max-w-full [&_img]:rounded-md [&_img.ProseMirror-selectednode]:ring-2 [&_img.ProseMirror-selectednode]:ring-primary'
}
// Images upload as attachments and are stored as attachment:<id>
// (utils/editor-image.ts); pasted, dropped or picked from the toolbar
const descriptionExtensions = [AttachmentImage]
const descriptionEditor = useTemplateRef<{ editor?: { view: EditorView } }>('descriptionEditor')
const imageInput = useTemplateRef<HTMLInputElement>('imageInput')
async function uploadImage(file: File): Promise<{ id: string } | null> {
  const name = file.name || 'pasted-image.png'
  const problem = attachmentProblem(file)
  if (problem) {
    toast.add({ title: `Couldn't add ${name}`, description: problem, color: 'error' })
    return null
  }
  uploading.value++
  try {
    return await uploadMutation.mutateAsync({ slug: props.slug ?? '', file, name })
  } catch (e) {
    toast.add({ title: `Couldn't upload ${name}`, description: e instanceof Error ? e.message : String(e), color: 'error' })
    return null
  } finally {
    uploading.value--
  }
}
const descriptionEditorProps = {
  handlePaste: (view: EditorView, event: ClipboardEvent) => {
    const files = imageFiles(event.clipboardData)
    if (files.length === 0) return false
    insertImages(view, files, uploadImage)
    return true
  },
  handleDrop: (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean) => {
    const files = moved ? [] : imageFiles(event.dataTransfer)
    if (files.length === 0) return false
    event.preventDefault()
    insertImages(view, files, uploadImage, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
    return true
  }
}
function onImagePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const view = descriptionEditor.value?.editor?.view
  if (view) insertImages(view, imageFiles({ files: input.files } as DataTransfer), uploadImage)
  input.value = ''
}
const toolbarItems: EditorToolbarItem[][] = [
  [
    { 'kind': 'mark', 'mark': 'bold', 'icon': 'i-lucide-bold', 'aria-label': 'Bold' },
    { 'kind': 'mark', 'mark': 'italic', 'icon': 'i-lucide-italic', 'aria-label': 'Italic' },
    { 'kind': 'mark', 'mark': 'code', 'icon': 'i-lucide-code', 'aria-label': 'Inline code' }
  ],
  [
    { 'kind': 'heading', 'level': 2, 'icon': 'i-lucide-heading-2', 'aria-label': 'Heading' },
    { 'kind': 'bulletList', 'icon': 'i-lucide-list', 'aria-label': 'Bulleted list' },
    { 'kind': 'orderedList', 'icon': 'i-lucide-list-ordered', 'aria-label': 'Numbered list' },
    { 'kind': 'codeBlock', 'icon': 'i-lucide-square-code', 'aria-label': 'Code block' },
    { 'kind': 'link', 'icon': 'i-lucide-link', 'aria-label': 'Link' },
    { 'icon': 'i-lucide-image', 'aria-label': 'Insert image', 'onClick': () => imageInput.value?.click() }
  ]
] as const
</script>

<template>
  <template v-if="props.editing">
    <UEditor
      ref="descriptionEditor"
      v-slot="{ editor }"
      :model-value="props.doc as never"
      content-type="json"
      :image="false"
      :extensions="descriptionExtensions"
      :editor-props="descriptionEditorProps"
      autofocus="end"
      class="rounded-md ring-2 ring-primary"
      :ui="{ ...descriptionUi, base: `${descriptionUi.base} min-h-24 px-3 py-2 sm:px-3` }"
      placeholder="Describe the task…"
      @update:model-value="emit('update:doc', $event as never)"
      @keydown.esc="emit('cancel')"
    >
      <UEditorToolbar
        :editor="editor"
        :items="toolbarItems"
        class="border-b border-default px-1 py-1"
      />
    </UEditor>
    <input
      ref="imageInput"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      class="hidden"
      @change="onImagePicked"
    >
  </template>
  <UEditor
    v-else
    :model-value="(props.doc ?? { type: 'doc', content: [] }) as never"
    content-type="json"
    :editable="false"
    :image="false"
    :extensions="descriptionExtensions"
    placeholder="Add a description…"
    :ui="{ base: `${descriptionUi.base} [&>p:last-child:not(:first-child):has(>br:only-child)]:hidden` }"
  />
</template>
