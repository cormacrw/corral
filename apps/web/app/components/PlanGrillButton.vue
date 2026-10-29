<script setup lang="ts">
import { grillMessage } from '~/utils/plan-questions'

// Grill me, in the Plan composer: asks the PM to question you, about the
// draft if there is one
const props = defineProps<{ draft: string, disabled?: boolean }>()
const emit = defineEmits<{ send: [message: string] }>()
</script>

<template>
  <UButton
    label="Grill me"
    icon="i-lucide-flame"
    size="xs"
    variant="ghost"
    color="neutral"
    :disabled="props.disabled"
    @click="emit('send', grillMessage(props.draft))"
  />
</template>
