<script setup lang="ts">
import type { ReleaseNotesItem } from '@corral/contracts'
import { useMutation } from '@tanstack/vue-query'
import { dismissDeployment, readDeployment } from '~/queries/inbox'
import { timeAgo } from '~/utils/labels'

const props = defineProps<{ item: ReleaseNotesItem }>()
const read = useMutation(readDeployment)
const dismiss = useMutation(dismissDeployment)
const error = computed(() => (dismiss.error.value ?? read.error.value)?.message ?? null)
// By deployment, not its unread flag: a failed read restores the flag, and
// must not try again in a loop
watch(() => props.item.deploymentId, (id) => {
  if (props.item.unread) read.mutate(id)
}, { immediate: true })
</script>

<template>
  <section
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    aria-label="Release notes"
  >
    <header class="flex shrink-0 items-center gap-3 border-b border-default p-4">
      <AgentAvatar
        :name="item.sender.name"
        size="sm"
      />
      <div class="min-w-0">
        <h1 class="font-semibold">
          Release notes
        </h1>
        <div class="flex items-center gap-1 text-xs text-muted">
          <ProjectThumbnail
            :project="item.project"
            :size="16"
          />{{ item.project.name }}
        </div>
        <p class="text-xs text-muted">
          {{ item.sender.name }} · PM · {{ timeAgo(item.at) }}
        </p>
      </div>
    </header>
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <p class="font-mono text-sm text-muted">
        {{ item.fromSha ? `${item.fromSha}…` : 'First deploy · ' }}{{ item.toSha }}
      </p>
      <UAlert
        v-if="item.resolution"
        title="Resolved"
        :description="item.resolution"
        color="success"
        variant="subtle"
      />
      <p
        v-if="item.notesStatus === 'pending'"
        role="status"
        class="text-sm text-muted"
      >
        Writing release notes…
      </p>
      <MarkdownText
        v-else
        :text="item.notes ?? ''"
        class="text-sm"
      />
      <UAlert
        v-if="error"
        :title="error"
        color="error"
        variant="subtle"
      />
    </div>
    <footer
      v-if="!item.resolution"
      class="shrink-0 border-t border-default p-3"
    >
      <UButton
        label="Dismiss"
        color="neutral"
        variant="outline"
        :loading="dismiss.isPending.value"
        @click="dismiss.mutate(item.deploymentId)"
      />
    </footer>
  </section>
</template>
