<script setup lang="ts">
import type { InboxPanel } from '~/composables/useInboxPanel'

// The key artifacts: screenshot thumbnails (opening the evidence viewer),
// the PR and a design's preview, each opening in a new tab
const props = withDefaults(defineProps<{ p: InboxPanel, size?: 'sm' | 'md' | 'lg', links?: boolean, files?: boolean }>(), { size: 'md', links: true, files: true })
const thumb = computed(() => ({ sm: 'h-12 w-20', md: 'h-20 w-32', lg: 'h-28 w-44' }[props.size]))
</script>

<template>
  <div
    v-if="p.images.value.length || (links && (p.pr.value || p.preview.value)) || (files && p.files.value.length)"
    class="flex flex-wrap items-center gap-2"
    data-testid="inbox-artifacts"
  >
    <button
      v-for="e in p.images.value"
      :key="e.id"
      type="button"
      :class="['group relative shrink-0 overflow-hidden rounded-md border border-default bg-muted hover:ring-2 hover:ring-primary focus-visible:ring-2 focus-visible:ring-primary', thumb]"
      :title="e.fileName ?? undefined"
      :aria-label="`Open ${e.fileName}`"
      @click="p.view(e)"
    >
      <img
        :src="e.url ?? undefined"
        :alt="e.note || e.fileName || ''"
        class="size-full object-cover object-top"
      >
    </button>
    <UButton
      v-for="e in files ? p.files.value : []"
      :key="e.id"
      :label="e.fileName ?? 'File'"
      icon="i-lucide-file-text"
      color="neutral"
      variant="ghost"
      size="xs"
      class="max-w-40"
      :ui="{ label: 'truncate' }"
      @click="p.view(e)"
    />
    <template v-if="links">
      <UButton
        v-if="p.pr.value"
        :to="p.pr.value.url"
        target="_blank"
        :label="p.pr.value.number ? `PR #${p.pr.value.number}` : 'Open PR'"
        icon="i-lucide-git-pull-request"
        trailing-icon="i-lucide-arrow-up-right"
        color="neutral"
        variant="outline"
        size="sm"
      />
      <UButton
        v-if="p.preview.value"
        :to="p.preview.value.url"
        target="_blank"
        :label="p.preview.value.label"
        icon="i-lucide-monitor-smartphone"
        trailing-icon="i-lucide-arrow-up-right"
        color="neutral"
        variant="outline"
        size="sm"
      />
    </template>
  </div>
</template>
