<script setup lang="ts">
import { errorMessage } from '~/lib/errors'
import { useMutation } from '@tanstack/vue-query'
import { attachmentUrl } from '@corral/core'
import { uploadAttachment } from '~/queries/attachments'
import { readDraft, writeDraft } from '~/composables/useDraft'
import { useDevice } from '~/composables/useDevice'
import { attachmentProblem, withAttachments } from '~/utils/attachments'
import { Comment, Fragment, useSlots, type VNode } from 'vue'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '~/components/ui/input-group'

// The shared prompt composer (design/README.md): every prompt box in the app.
// It's shadcn's prompt input, an InputGroup holding an auto-growing textarea
// with attachments above it and a toolbar below. Quick actions change what Send does. With a project, images
// can be pasted, dropped or picked: each uploads straight away and goes out
// as ![name](attachment:<id>) after the text.
const props = withDefaults(defineProps<{
  inputId?: string
  placeholder?: string
  hint?: string
  disabled?: boolean
  busy?: boolean
  submitLabel?: string
  // Just the arrow, with the label as its accessible name and tooltip
  submitIconOnly?: boolean
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
  // No toolbar: only Send, at the end of the input. Images can still be
  // pasted or dropped. Plan's new session uses it on phones.
  bare?: boolean
  // Bound with @submit. Resolving to false means it wasn't sent, so the
  // images stay for another try.
  onSubmit?: (text: string) => unknown
}>(), { placeholder: 'Write a message…', hint: '', disabled: false, busy: false, submitLabel: '', submitIconOnly: false, submitColor: 'primary', allowEmpty: false, rows: 2, project: null, draftKey: '', bare: false, onSubmit: undefined })

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
const submitAppearance = computed(() => props.submitLabel && !props.submitIconOnly
  ? { label: props.submitLabel, trailingIcon: 'i-hugeicons-arrow-up-02' }
  : { 'icon': 'i-hugeicons-arrow-up-02', 'aria-label': props.submitLabel || 'Send', 'title': props.submitLabel || undefined })

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
const box = ref<{ $el: HTMLElement } | null>(null)
defineExpose({ focus: () => box.value?.$el.querySelector('textarea')?.focus(), send, uploading, hasImages: computed(() => images.value.length > 0) })

// A header slot can render nothing (e.g. no attached task), so the row above
// the textarea shows only when it has something in it
const slots = useSlots()
function rendersSomething(nodes: VNode[] | undefined): boolean {
  return !!nodes?.some(node => node.type === Fragment ? rendersSomething(node.children as VNode[]) : node.type !== Comment)
}

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
  <InputGroup
    ref="box"
    :data-disabled="props.disabled || undefined"
    :class="['bg-background', dragging && 'border-primary ring-3 ring-primary/50']"
    @paste="onPaste"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <InputGroupAddon
      v-if="images.length > 0 || rendersSomething(slots.header?.())"
      align="block-start"
      class="cursor-default flex-col items-stretch gap-2 pt-2.5 font-normal text-foreground select-auto"
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
    </InputGroupAddon>
    <InputGroupTextarea
      :id="props.inputId"
      v-model="text"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      :rows="props.rows"
      :class="['max-h-64 px-3', props.bare ? 'min-h-36 pr-16 pb-14' : 'min-h-0']"
      @keydown.enter="onEnter"
    />
    <InputGroupAddon
      v-if="props.bare"
      align="inline-end"
      class="absolute right-2 bottom-2 cursor-default p-0 has-[>button]:mr-0"
    >
      <AppButton
        v-bind="submitAppearance"
        :color="props.submitColor"
        :disabled="!canSend"
        :loading="props.busy || uploading"
        size="sm"
        class="relative size-8 rounded-full after:absolute after:-inset-1.5"
        data-testid="composer-send"
        @click="send()"
      />
    </InputGroupAddon>
    <InputGroupAddon
      v-else
      align="block-end"
      class="cursor-default gap-1"
    >
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
          <InputGroupButton
            size="icon-xs"
            aria-label="Attach images"
            class="tap-target"
            :disabled="props.disabled"
            @click="picker?.click()"
          >
            <Icon name="i-hugeicons-attachment-01" />
          </InputGroupButton>
        </template>
        <slot name="tools" />
        <!-- What sending does, when a host says; no keyboard hints -->
        <span
          v-if="props.hint"
          class="ms-auto hidden truncate text-xs font-normal text-muted-foreground/70 sm:inline"
        >{{ props.hint }}</span>
      </div>
      <!-- Controls that belong with sending, such as the model, sit by Send -->
      <slot name="send-tools" />
      <AppButton
        v-bind="submitAppearance"
        :color="props.submitColor"
        :disabled="!canSend"
        :loading="props.busy || uploading"
        size="sm"
        class="tap-target rounded-full"
        @click="send()"
      />
    </InputGroupAddon>
  </InputGroup>
</template>
