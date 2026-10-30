<script setup lang="ts">
// The drawer the hidden text opens in: a side sheet on desktop, a bottom
// sheet on a phone
defineProps<{ title: string, mobile?: boolean }>()
const open = defineModel<boolean>('open', { required: true })
</script>

<template>
  <UDrawer
    v-if="mobile"
    v-model:open="open"
    :title="title"
    :ui="{ content: 'max-h-[88svh]', body: 'overflow-y-auto overscroll-contain' }"
  >
    <template #body>
      <slot />
    </template>
  </UDrawer>
  <USlideover
    v-else
    v-model:open="open"
    :title="title"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <slot />
    </template>
  </USlideover>
</template>
