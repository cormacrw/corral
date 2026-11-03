<script setup lang="ts">
import type { Evidence } from '@corral/contracts'

// Screenshots as a grid of thumbnails, each opening in the viewer
defineProps<{ shots: { evidence: Evidence, caption: string | null }[], mobile?: boolean }>()
defineEmits<{ open: [evidence: Evidence] }>()
</script>

<template>
  <div :class="['grid gap-2', mobile ? 'grid-cols-2' : 'grid-cols-3']">
    <button
      v-for="{ evidence, caption } in shots"
      :key="evidence.id"
      type="button"
      class="min-w-0 overflow-hidden rounded-md border border-border text-start hover:ring-2 hover:ring-primary focus-visible:ring-2 focus-visible:ring-primary"
      :aria-label="`Open ${evidence.fileName}`"
      @click="$emit('open', evidence)"
    >
      <img
        :src="evidence.url ?? undefined"
        :alt="evidence.note || evidence.fileName || ''"
        class="aspect-video w-full object-cover object-top"
      >
      <span class="block truncate px-2 py-1 text-xs text-muted-foreground">{{ caption }}</span>
    </button>
  </div>
</template>
