<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { attachmentUrl } from '@corral/core'
import { uploadAttachment } from '~/queries/attachments'
import { attachmentProblem, withAttachments } from '~/utils/attachments'

// The shared prompt composer (design/README.md): an auto-growing textarea
// and a toolbar. Quick actions change what Send does. With a project, images
// can be pasted, dropped or picked: each uploads straight away and goes out
// as ![name](attachment:<id>) after the text.
const props = withDefaults(defineProps<{
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
  // Bound with @submit. Resolving to false means it wasn't sent, so the
  // images stay for another try.
  onSubmit?: (text: string) => unknown
}>(), { placeholder: 'Write a message…', hint: '', disabled: false, busy: false, submitLabel: '', submitColor: 'primary', allowEmpty: false, rows: 2, project: null, onSubmit: undefined })

const text = defineModel<string>({ default: '' })
const toast = useToast()
const upload = useMutation(uploadAttachment)

interface Image {
  key: number
  name: string
  preview: string
  status: 'uploading' | 'done' | 'failed'
  id?: string
  error?: string
}
const images = ref<Image[]>((props.initialImages ?? []).map((image, key) => ({ ...image, key, preview: attachmentUrl(image.id), status: 'done' })))
const picker = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const sending = ref(false)
let nextKey = images.value.length

const uploading = computed(() => images.value.some(i => i.status === 'uploading'))
const ready = computed(() => images.value.filter(i => i.status === 'done'))
const available = computed(() => !props.disabled && !props.busy && !sending.value && !uploading.value)
const canSend = computed(() => available.value && (props.allowEmpty || text.value.trim().length > 0 || ready.value.length > 0))

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
    }, (e: unknown) => {
      image.status = 'failed'
      image.error = e instanceof Error ? e.message : String(e)
      toast.add({ title: `Couldn't upload ${name}`, description: image.error, color: 'error' })
    })
  }
}

function remove(image: Image) {
  URL.revokeObjectURL(image.preview)
  images.value = images.value.filter(i => i.key !== image.key)
}
onBeforeUnmount(() => images.value.forEach(i => URL.revokeObjectURL(i.preview)))

// Lets a page put the cursor in the composer (e.g. Other… on a question)
const box = ref<HTMLElement | null>(null)
defineExpose({ focus: () => box.value?.querySelector('textarea')?.focus(), send, uploading, hasImages: computed(() => images.value.length > 0) })

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
  <!-- UChatPrompt passes listeners to its textarea, so the whole box listens here -->
  <div
    ref="box"
    :class="['rounded-lg', dragging && 'ring-2 ring-primary']"
    @paste="onPaste"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <UChatPrompt
      v-model="text"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      :rows="props.rows"
      :autofocus="false"
      variant="outline"
      @submit.prevent="send()"
    >
      <template #header>
        <ul
          v-if="images.length > 0"
          class="flex flex-wrap gap-2"
          aria-label="Attached images"
        >
          <li
            v-for="image in images"
            :key="image.key"
            class="relative size-16 shrink-0 overflow-hidden rounded-md border border-default bg-muted"
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
              <UIcon
                name="i-lucide-loader-circle"
                class="size-5 animate-spin text-highlighted"
              />
            </span>
            <span
              v-else-if="image.status === 'failed'"
              class="absolute inset-0 flex items-center justify-center bg-error/20"
              aria-label="Upload failed"
            >
              <UIcon
                name="i-lucide-triangle-alert"
                class="size-5 text-error"
              />
            </span>
            <UButton
              icon="i-lucide-x"
              size="xs"
              color="neutral"
              variant="solid"
              class="absolute end-0.5 top-0.5 rounded-full p-0.5"
              :aria-label="`Remove ${image.name}`"
              @click="remove(image)"
            />
          </li>
        </ul>
        <slot name="header" />
      </template>
      <template #footer>
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
            <UButton
              icon="i-lucide-paperclip"
              size="xs"
              variant="ghost"
              color="neutral"
              aria-label="Attach images"
              :disabled="props.disabled"
              @click="picker?.click()"
            />
          </template>
          <slot name="tools" />
          <span class="ms-auto hidden truncate text-xs text-dimmed sm:inline">{{ props.hint || 'Enter to send · Shift+Enter for new line' }}</span>
        </div>
        <UButton
          v-if="props.submitLabel"
          :label="props.submitLabel"
          :color="props.submitColor"
          trailing-icon="i-lucide-arrow-up"
          :disabled="!canSend"
          :loading="props.busy || uploading"
          size="sm"
          @click="send()"
        />
        <UButton
          v-else
          icon="i-lucide-arrow-up"
          :color="props.submitColor"
          aria-label="Send"
          :disabled="!canSend"
          :loading="props.busy || uploading"
          size="sm"
          @click="send()"
        />
      </template>
    </UChatPrompt>
  </div>
</template>
