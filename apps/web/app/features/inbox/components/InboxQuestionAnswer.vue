<script setup lang="ts">
// Other… written in a Plan question's card in the Inbox: each question holds
// its own answer, and the page's Submit sends it
defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ submit: [] }>()
const answer = defineModel<string>({ default: '' })
</script>

<template>
  <AppTextarea
    v-model="answer"
    placeholder="Your answer…"
    aria-label="Your answer"
    autoresize
    autofocus
    :rows="2"
    :disabled="disabled"
    class="min-h-16 bg-background text-sm"
    data-testid="plan-question-other"
    @keydown.enter.meta.prevent="emit('submit')"
    @keydown.enter.ctrl.prevent="emit('submit')"
  />
</template>
