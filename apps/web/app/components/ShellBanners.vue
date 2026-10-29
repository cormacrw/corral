<script setup lang="ts">
import type { Project } from '@corral/contracts'
import { api } from '~/composables/useApi'

// Shell-wide banners (design/app-shell.md), shared by the web and mobile
// layouts: kill switch, update hold, paused project, runner offline
const state = useLive().state
const route = useRoute()
const toast = useToast()

const currentSlug = computed(() => typeof route.params.slug === 'string' ? route.params.slug : null)
const currentProject = computed(() => state.value.projects.find(p => p.slug === currentSlug.value) ?? null)

async function resume(project: Project) {
  try {
    await api.projects.patch(project.slug, { paused: false })
  } catch (error) {
    toast.add({ title: 'Could not resume', description: error instanceof Error ? error.message : String(error), color: 'error' })
  }
}
async function resumeAll() {
  try {
    await api.resumeAll()
  } catch (error) {
    toast.add({ title: 'Could not resume', description: error instanceof Error ? error.message : String(error), color: 'error' })
  }
}
</script>

<template>
  <UAlert
    v-if="state.status.stopped"
    color="error"
    variant="solid"
    icon="i-lucide-octagon-x"
    title="Corral is stopped. No runs will start until you resume."
    :ui="{ root: 'shrink-0 rounded-none py-2' }"
    orientation="horizontal"
    :actions="[{ label: 'Resume everything', color: 'neutral', variant: 'solid', onClick: resumeAll }]"
  />
  <UAlert
    v-else-if="state.status.updating"
    color="info"
    variant="subtle"
    icon="i-lucide-download"
    title="Corral is updating. Running work will finish first; new runs start once the update is done. You can keep chatting in Plan."
    :ui="{ root: 'shrink-0 rounded-none py-2' }"
    orientation="horizontal"
  />
  <UAlert
    v-else-if="currentProject?.paused"
    color="warning"
    variant="solid"
    icon="i-lucide-pause"
    :title="`${currentProject.name} is paused. No new runs will start; work already running will finish.`"
    :ui="{ root: 'shrink-0 rounded-none py-2' }"
    orientation="horizontal"
    :actions="[{ label: 'Resume', color: 'neutral', variant: 'solid', onClick: () => resume(currentProject!) }]"
  />
  <UAlert
    v-else-if="state.loaded && !state.runner?.online"
    color="warning"
    variant="subtle"
    icon="i-lucide-server-off"
    title="The runner is offline. Plan and live runs are unavailable until it reconnects."
    :ui="{ root: 'shrink-0 rounded-none py-2' }"
    orientation="horizontal"
  />
  <UAlert
    v-else-if="state.connection === 'reconnecting'"
    color="neutral"
    variant="subtle"
    icon="i-lucide-refresh-cw"
    title="Reconnecting to Corral…"
    :ui="{ root: 'shrink-0 rounded-none py-2' }"
    orientation="horizontal"
  />
</template>
