<script setup lang="ts">
// The shared prompt composer (design/README.md): an auto-growing textarea
// and a toolbar. Quick actions change what Send does.
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
}>(), { placeholder: 'Write a message…', hint: '', disabled: false, busy: false, submitLabel: '', submitColor: 'primary', allowEmpty: false, rows: 2 })

const emit = defineEmits<{ submit: [text: string] }>()
const text = defineModel<string>({ default: '' })

const canSend = computed(() => !props.disabled && !props.busy && (props.allowEmpty || text.value.trim().length > 0))

function send() {
  if (!canSend.value) return
  emit('submit', text.value.trim())
}
</script>

<template>
  <UChatPrompt
    v-model="text"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    :rows="props.rows"
    :autofocus="false"
    variant="outline"
    @submit.prevent="send"
  >
    <template #header>
      <slot name="header" />
    </template>
    <template #footer>
      <div class="flex min-w-0 flex-1 items-center gap-1">
        <slot name="tools" />
        <span class="ms-auto hidden truncate text-xs text-dimmed sm:inline">{{ props.hint || 'Enter to send · Shift+Enter for new line' }}</span>
      </div>
      <UButton
        v-if="props.submitLabel"
        :label="props.submitLabel"
        :color="props.submitColor"
        trailing-icon="i-lucide-arrow-up"
        :disabled="!canSend"
        :loading="props.busy"
        size="sm"
        @click="send"
      />
      <UButton
        v-else
        icon="i-lucide-arrow-up"
        :color="props.submitColor"
        aria-label="Send"
        :disabled="!canSend"
        :loading="props.busy"
        size="sm"
        @click="send"
      />
    </template>
  </UChatPrompt>
</template>
