<script setup lang="ts">
import type { ReleaseNotesItem } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { timeAgo } from '~/utils/labels'

const props = defineProps<{ item: ReleaseNotesItem }>()
const emit = defineEmits<{ read: [], refresh: [] }>()
const error = ref<string | null>(null)
const busy = ref(false)
const { state } = useLive()
const taskPrefixes = computed(() => state.value.projects.map(p => p.prefix))
watch(() => props.item.unread && props.item.deploymentId, async () => {
  if (!props.item.unread) return
  try {
    await api.deployments.read(props.item.deploymentId)
    emit('read')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}, { immediate: true })
async function dismiss() {
  busy.value = true
  error.value = null
  try {
    await api.deployments.dismiss(props.item.deploymentId)
    emit('refresh')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
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
        :task-refs="taskPrefixes"
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
        :loading="busy"
        @click="dismiss"
      />
    </footer>
  </section>
</template>
