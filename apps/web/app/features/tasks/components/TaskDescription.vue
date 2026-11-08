<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
import { useMutation } from '@tanstack/vue-query'
import type { EditorView } from '@tiptap/pm/view'
import { uploadAttachment } from '~/queries/attachments'
import { attachmentProblem, IMAGE_ACCEPT } from '~/utils/attachments'
import { AttachmentImage, imageFiles, insertImages } from '~/features/tasks/utils/editor-image'

// A task's description being edited. Its own chunk, since the editor is the
// largest thing on the page. RichTextText renders the read-only view.
const props = defineProps<{ doc: unknown, slug?: string }>()
const emit = defineEmits<{ 'update:doc': [doc: { type: 'doc', content?: never[] }], 'cancel': [] }>()
const uploading = defineModel<number>('uploading', { default: 0 })

const toast = useToast()
const uploadMutation = useMutation(uploadAttachment)
// The editor's defaults suit a full page; a task's description sits in a
// narrow column at body text size
const descriptionClass = 'min-h-24 px-3 py-2 text-sm *:my-2 [&_p]:leading-6 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h2>code]:text-sm [&_h3>code]:text-sm [&_li]:my-0.5 [&_pre]:px-3 [&_pre]:py-2 [&_pre]:text-xs/5 [&_code]:text-xs [&_img]:max-w-full [&_img]:rounded-md [&_img.ProseMirror-selectednode]:ring-2 [&_img.ProseMirror-selectednode]:ring-primary'
// Images upload as attachments and are stored as attachment:<id>
// (utils/editor-image.ts); pasted, dropped or picked from the toolbar
const descriptionExtensions = [AttachmentImage]
const descriptionEditor = useTemplateRef<{ view: () => EditorView | undefined }>('descriptionEditor')
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
    toast.add({ title: `Couldn't upload ${name}`, description: errorMessage(e), color: 'error' })
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
  const view = descriptionEditor.value?.view()
  if (view) insertImages(view, imageFiles({ files: input.files } as DataTransfer), uploadImage)
  input.value = ''
}
const toolbarItems = [
  [
    { kind: 'bold', icon: 'i-hugeicons-text-bold', label: 'Bold' },
    { kind: 'italic', icon: 'i-hugeicons-text-italic', label: 'Italic' },
    { kind: 'code', icon: 'i-hugeicons-source-code', label: 'Inline code' }
  ],
  [
    { kind: 'heading', icon: 'i-hugeicons-heading-02', label: 'Heading' },
    { kind: 'bulletList', icon: 'i-hugeicons-left-to-right-list-bullet', label: 'Bulleted list' },
    { kind: 'orderedList', icon: 'i-hugeicons-left-to-right-list-number', label: 'Numbered list' },
    { kind: 'codeBlock', icon: 'i-hugeicons-source-code-square', label: 'Code block' },
    { kind: 'link', icon: 'i-hugeicons-link-01', label: 'Link' },
    { icon: 'i-hugeicons-image-01', label: 'Insert image', onClick: () => imageInput.value?.click() }
  ]
] as const
</script>

<template>
  <AppEditor
    ref="descriptionEditor"
    :model-value="props.doc"
    :extensions="descriptionExtensions"
    :editor-props="descriptionEditorProps"
    :tools="toolbarItems"
    :content-class="descriptionClass"
    class="rounded-md ring-2 ring-primary"
    placeholder="Describe the task…"
    @update:model-value="emit('update:doc', $event as never)"
    @keydown.esc="emit('cancel')"
  />
  <input
    ref="imageInput"
    type="file"
    :accept="IMAGE_ACCEPT"
    multiple
    class="hidden"
    @change="onImagePicked"
  >
</template>
