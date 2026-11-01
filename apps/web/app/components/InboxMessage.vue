<script setup lang="ts">
import type { Evidence, InboxArtifact } from '@corral/contracts'
import { ref } from 'vue'
import EvidenceViewer from './EvidenceViewer.vue'
import type { ViewerFile } from './EvidenceViewer.vue'

const props = defineProps<{
  item: { message?: string, body: string, newArtifacts?: InboxArtifact[] }
  evidence?: Evidence[]
  // Up top in the panel: a clamped message and one row, with the body in its own tab
  summary?: boolean
}>()
const open = ref<ViewerFile | null>(null)
// Before evidence loads, or where there is none, the type is a guess from the
// artifact's kind. Unknown stays null, which the viewer offers as a download.
function file(artifact: InboxArtifact): ViewerFile {
  return props.evidence?.find(e => e.id === artifact.id) ?? {
    id: artifact.id,
    fileName: artifact.name,
    kind: artifact.kind === 'design' ? 'other' : artifact.kind,
    createdAt: artifact.at,
    note: '',
    url: artifact.url,
    contentType: artifact.kind === 'screenshot' || /\.(png|jpe?g|gif|webp|svg)$/i.test(artifact.name)
      ? 'image/png'
      : artifact.kind === 'video' ? 'video/mp4' : ['request', 'log', 'text', 'test_output'].includes(artifact.kind) ? 'text/plain' : null
  }
}
</script>

<template>
  <section
    v-if="item.message"
    aria-label="Message"
    class="min-w-0 space-y-3"
  >
    <p :class="['[overflow-wrap:anywhere]', summary ? 'line-clamp-3 text-sm' : 'text-base whitespace-pre-wrap']">
      <TaskRefText :text="item.message" />
    </p>
    <div
      v-if="item.newArtifacts?.length"
      aria-label="New artifacts"
      :class="['flex items-center gap-2', summary ? 'overflow-x-auto' : 'flex-wrap']"
    >
      <span class="shrink-0 text-xs font-medium text-muted">New</span>
      <template
        v-for="artifact in item.newArtifacts"
        :key="artifact.id"
      >
        <a
          v-if="artifact.kind === 'design'"
          :href="artifact.url"
          target="_blank"
          rel="noopener"
          class="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-default px-3 text-sm text-primary hover:bg-elevated"
        >
          <UIcon
            name="i-lucide-panels-top-left"
            class="size-4 shrink-0"
          />
          {{ artifact.name }} · Preview
        </a>
        <button
          v-else
          type="button"
          :class="['flex min-h-11 items-center gap-2 rounded-md border border-default p-1.5 text-start text-xs hover:bg-elevated', summary ? 'max-w-56 shrink-0' : 'max-w-full']"
          @click="open = file(artifact)"
        >
          <img
            v-if="file(artifact).contentType?.startsWith('image/')"
            :src="artifact.url"
            :alt="artifact.name"
            loading="lazy"
            class="size-12 shrink-0 rounded object-cover"
          >
          <UIcon
            v-else
            :name="artifact.kind === 'video' ? 'i-lucide-video' : 'i-lucide-file-text'"
            class="size-6 shrink-0 text-muted"
          />
          <span class="min-w-0 [overflow-wrap:anywhere]">
            <span
              v-if="artifact.taskRef"
              class="block text-muted"
            >{{ artifact.taskRef }}</span>
            {{ artifact.name }}
          </span>
        </button>
      </template>
    </div>
    <details
      v-if="item.body && !summary"
      class="min-w-0"
    >
      <summary class="min-h-11 cursor-pointer content-center rounded-md text-sm text-muted focus-visible:outline-2 focus-visible:outline-primary">
        Full message
      </summary>
      <MarkdownText :text="item.body" />
    </details>
    <EvidenceViewer v-model="open" />
  </section>
  <MarkdownText
    v-else
    :text="item.body"
  />
</template>
