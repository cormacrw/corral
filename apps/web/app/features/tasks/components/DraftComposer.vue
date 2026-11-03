<script setup lang="ts">
// A PromptComposer whose text stays with a large parent that doesn't read it
// while rendering, so a keystroke re-renders this and not the parent.
const props = defineProps<{ draft: { text: Ref<string> } }>()
const text = props.draft.text
</script>

<template>
  <PromptComposer v-model="text" />
</template>
