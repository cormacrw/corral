<script setup lang="ts">
import type { Evidence } from '@corral/contracts'
import type { EvidenceKind } from '@corral/core'
import { computed } from 'vue'
import EvidenceFiles from '~/features/evidence/components/EvidenceFiles.vue'

const props = defineProps<{ evidence: Evidence[] }>()
const emit = defineEmits<{ open: [item: Evidence] }>()
// What a person looks at; every other file kind is an artifact
const HUMAN_KINDS: readonly EvidenceKind[] = ['screenshot', 'video', 'request']
const human = computed(() => props.evidence.filter(e => HUMAN_KINDS.includes(e.kind)))
const notes = computed(() => props.evidence.filter(e => e.kind === 'note'))
const artifacts = computed(() => props.evidence.filter(e => e.kind !== 'note' && !HUMAN_KINDS.includes(e.kind)))
</script>

<template>
  <EvidenceFiles
    v-if="human.length"
    :evidence="human"
    @open="emit('open', $event)"
  />
  <div
    v-for="item in notes"
    :key="item.id"
    class="mt-2 rounded-md border border-border bg-muted/50 p-2 text-xs"
  >
    <p class="mb-1 text-muted-foreground">
      Note · round {{ item.round + 1 }}
    </p>
    <MarkdownText :text="item.note" />
  </div>
  <p
    v-if="props.evidence.length === 0"
    class="mt-2 text-xs text-muted-foreground/70"
  >
    No evidence attached.
  </p>
  <details
    v-if="artifacts.length"
    class="mt-2"
  >
    <summary class="tap-target flex cursor-pointer items-center rounded-md text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary">
      Agent artifacts ({{ artifacts.length }})
    </summary>
    <EvidenceFiles
      :evidence="artifacts"
      @open="emit('open', $event)"
    />
  </details>
</template>
