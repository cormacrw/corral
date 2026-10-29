<script setup lang="ts">
import type { Evidence } from '@corral/contracts'

defineProps<{ evidence: Evidence[] }>()
const emit = defineEmits<{ open: [item: Evidence] }>()
</script>

<template>
  <div class="mt-2 flex flex-wrap gap-2">
    <button
      v-for="item in evidence"
      :key="item.id"
      type="button"
      class="flex max-w-56 items-center gap-2 rounded-md border border-default p-1.5 text-start text-xs hover:bg-elevated"
      @click="emit('open', item)"
    >
      <img
        v-if="item.contentType?.startsWith('image/')"
        :src="item.url ?? undefined"
        :alt="item.note || item.fileName || undefined"
        class="size-12 shrink-0 rounded object-cover"
      >
      <UIcon
        v-else
        :name="item.contentType?.startsWith('video/') ? 'i-lucide-video' : 'i-lucide-file-text'"
        class="size-6 shrink-0 text-muted"
      />
      <span class="min-w-0">
        <span class="block truncate font-medium">{{ item.fileName }}</span>
        <span class="block truncate text-muted">{{ item.kind.replace('_', ' ') }} · round {{ item.round + 1 }}</span>
      </span>
    </button>
  </div>
</template>
