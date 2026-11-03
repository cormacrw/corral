<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
import { useMutation } from '@tanstack/vue-query'
import { attachmentUrl } from '@corral/core'
import { uploadAttachment } from '~/queries/attachments'
import { readDraft, writeDraft } from '~/composables/useDraft'
import { useDevice } from '~/composables/useDevice'
import { attachmentProblem, withAttachments } from '~/utils/attachments'

// The shared prompt composer (design/README.md): an auto-growing textarea
// and a toolbar. Quick actions change what Send does. With a project, images
// can be pasted, dropped or picked: each uploads straight away and goes out
// as ![name](attachment:<id>) after the text.
const props = withDefaults(defineProps<{
  inputId?: string
  placeholder?: string
  hint?: string
  disabled?: boolean
  busy?: boolean
  submitLabel?: string
  submitColor?: 'primary' | 'error' | 'neutral'
  // Can send with an empty message (e.g. an action or attached task)
  allowEmpty?: boolean
  rows?: number
  // The project's slug, where images upload to; no slug, no attachments
  project?: string | null
  // Already uploaded images restored from a failed Plan start.
  initialImages?: { id: string, name: string }[]
  // Keeps uploaded images with the text's draft (useDraft)
  draftKey?: string
  // Bound with @submit. Resolving to false means it wasn't sent, so the
  // images stay for another try.
  onSubmit?: (text: string) => unknown
}>(), { placeholder: 'Write a message…', hint: '', disabled: false, busy: false, submitLabel: '', submitColor: 'primary', allowEmpty: false, rows: 2, project: null, draftKey: '', onSubmit: undefined })

const text = defineModel<string>({ default: '' })
const toast = useToast()
const device = useDevice()
const upload = useMutation(uploadAttachment)

interface Image {
  key: number
  name: string
  preview: string
  status: 'uploading' | 'done' | 'failed'
  id?: string
  error?: string
}
const imagesKey = props.draftKey && `${props.draftKey}:images`
function savedImages(): { id: string, name: string }[] {
  try {
    return JSON.parse(readDraft(imagesKey) || '[]')
  } catch {
    return []
  }
}
const restored = props.initialImages?.length ? props.initialImages : savedImages()
const images = ref<Image[]>(restored.map((image, key) => ({ ...image, key, preview: attachmentUrl(image.id), status: 'done' })))
const picker = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const sending = ref(false)
let nextKey = images.value.length
function saveImages() {
  const done = images.value.filter(i => i.status === 'done').map(i => ({ id: i.id!, name: i.name }))
  writeDraft(imagesKey, done.length ? JSON.stringify(done) : '')
}

const uploading = computed(() => images.value.some(i => i.status === 'uploading'))
const ready = computed(() => images.value.filter(i => i.status === 'done'))
const available = computed(() => !props.disabled && !props.busy && !sending.value && !uploading.value)
const canSend = computed(() => available.value && (props.allowEmpty || text.value.trim().length > 0 || ready.value.length > 0))
const submitAppearance = computed(() => props.submitLabel
  ? { label: props.submitLabel, trailingIcon: 'i-hugeicons-arrow-up-02' }
  : { 'icon': 'i-hugeicons-arrow-up-02', 'aria-label': 'Send' })

async function send(message = text.value) {
  if (!available.value || (!props.allowEmpty && !message.trim() && ready.value.length === 0)) return false
  const sent = ready.value
  sending.value = true
  try {
    const result = await props.onSubmit?.(withAttachments(message, sent.map(i => ({ id: i.id!, name: i.name }))))
    if (result !== false) for (const image of sent) remove(image)
    return result !== false
  } finally {
    sending.value = false
  }
}

function attach(files: Iterable<File>) {
  if (!props.project || props.disabled) return
  const slug = props.project
  for (const file of files) {
    const problem = attachmentProblem(file)
    if (problem) {
      toast.add({ title: `Can't attach ${file.name || 'that file'}`, description: problem, color: 'error' })
      continue
    }
    const name = file.name || `image.${file.type.slice(6)}`
    images.value.push({ key: nextKey++, name, preview: URL.createObjectURL(file), status: 'uploading' })
    const image = images.value[images.value.length - 1]!
    upload.mutateAsync({ slug, file, name }).then((attachment) => {
      image.status = 'done'
      image.id = attachment.id
      saveImages()
    }, (e: unknown) => {
      image.status = 'failed'
      image.error = errorMessage(e)
      toast.add({ title: `Couldn't upload ${name}`, description: image.error, color: 'error' })
    })
  }
}

function remove(image: Image) {
  URL.revokeObjectURL(image.preview)
  images.value = images.value.filter(i => i.key !== image.key)
  saveImages()
}
onBeforeUnmount(() => images.value.forEach(i => URL.revokeObjectURL(i.preview)))

// Lets a page put the cursor in the composer (e.g. Other… on a question)
const box = ref<HTMLElement | null>(null)
defineExpose({ focus: () => box.value?.querySelector('textarea')?.focus(), send, uploading, hasImages: computed(() => images.value.length > 0) })

function onEnter(event: KeyboardEvent) {
  if (device.isMobile.value || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void send()
}

function filesOf(data: DataTransfer | null): File[] {
  if (!data) return []
  return [...data.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((f): f is File => f !== null)
}
function onPaste(event: ClipboardEvent) {
  const files = filesOf(event.clipboardData)
  if (!props.project || files.length === 0) return
  event.preventDefault()
  attach(files)
}
function onDragOver(event: DragEvent) {
  if (!props.project || props.disabled || !event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dragging.value = true
}
// Leaving the box, not just moving between its children
function onDragLeave(event: DragEvent) {
  if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null)) dragging.value = false
}
function onDrop(event: DragEvent) {
  dragging.value = false
  if (!props.project) return
  event.preventDefault()
  attach(filesOf(event.dataTransfer))
}
function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  attach([...input.files ?? []])
  input.value = ''
}
</script>

<template>
  <!-- The whole box takes pasted and dropped images, not only the textarea -->
  <div
    ref="box"
    :class="['flex flex-col gap-2 rounded-lg border bg-background p-3 focus-within:ring-2 focus-within:ring-ring/50', dragging && 'ring-2 ring-primary']"
    @paste="onPaste"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <ul
      v-if="images.length > 0"
      class="flex flex-wrap gap-2"
      aria-label="Attached images"
    >
      <li
        v-for="image in images"
        :key="image.key"
        class="relative size-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted/50"
        :title="image.error ?? image.name"
      >
        <img
          :src="image.preview"
          :alt="image.name"
          :class="['size-full object-cover', image.status !== 'done' && 'opacity-50']"
        >
        <span
          v-if="image.status === 'uploading'"
          class="absolute inset-0 flex items-center justify-center"
          aria-label="Uploading"
        >
          <Icon
            name="i-hugeicons-loading-03"
            class="size-5 animate-spin text-foreground"
          />
        </span>
        <span
          v-else-if="image.status === 'failed'"
          class="absolute inset-0 flex items-center justify-center bg-destructive/20"
          aria-label="Upload failed"
        >
          <Icon
            name="i-hugeicons-alert-02"
            class="size-5 text-destructive"
          />
        </span>
        <AppButton
          icon="i-hugeicons-cancel-01"
          size="xs"
          color="neutral"
          variant="solid"
          class="absolute end-0.5 top-0.5 rounded-full p-0.5 after:absolute after:-inset-2"
          :aria-label="`Remove ${image.name}`"
          @click="remove(image)"
        />
      </li>
    </ul>
    <slot name="header" />
    <textarea
      :id="props.inputId"
      v-model="text"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      :rows="props.rows"
      class="field-sizing-content max-h-64 w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
      @keydown.enter="onEnter"
    />
    <div class="flex items-center gap-2">
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain">
        <template v-if="props.project">
          <input
            ref="picker"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            class="hidden"
            aria-label="Choose images to attach"
            @change="onPick"
          >
          <AppButton
            icon="i-hugeicons-attachment-01"
            size="xs"
            variant="ghost"
            color="neutral"
            aria-label="Attach images"
            class="tap-target"
            :disabled="props.disabled"
            @click="picker?.click()"
          />
        </template>
        <slot name="tools" />
        <span class="ms-auto hidden truncate text-xs text-muted-foreground/70 sm:inline">{{ props.hint || 'Enter to send · Shift+Enter for new line' }}</span>
      </div>
      <AppButton
        v-bind="submitAppearance"
        :color="props.submitColor"
        :disabled="!canSend"
        :loading="props.busy || uploading"
        size="sm"
        class="tap-target"
        @click="send()"
      />
    </div>
  </div>
</template>
