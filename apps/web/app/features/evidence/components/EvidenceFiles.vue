<script setup lang="ts">
import type { Evidence } from '@corral/contracts'
import { isImage, isVideo, kindLabel } from '~/features/evidence/utils/evidenceFile'

defineProps<{ evidence: Evidence[] }>()
const emit = defineEmits<{ open: [item: Evidence] }>()
</script>

<template>
  <div class="mt-2 flex flex-wrap gap-2">
    <button
      v-for="item in evidence"
      :key="item.id"
      type="button"
      class="tap-target flex max-w-56 items-center gap-2 rounded-md border border-border p-1.5 text-start text-xs hover:bg-muted"
      @click="emit('open', item)"
    >
      <img
        v-if="isImage(item)"
        :src="item.url ?? undefined"
        :alt="item.note || item.fileName || undefined"
        loading="lazy"
        class="size-12 shrink-0 rounded object-cover"
      >
      <Icon
        v-else
        :name="isVideo(item) ? 'i-ri-video-on-line' : 'i-ri-file-text-line'"
        class="size-6 shrink-0 text-muted-foreground"
      />
      <span class="min-w-0">
        <span class="block truncate font-medium">{{ item.fileName }}</span>
        <span class="block truncate text-muted-foreground">{{ kindLabel(item.kind) }} · round {{ item.round + 1 }}</span>
      </span>
    </button>
  </div>
</template>
