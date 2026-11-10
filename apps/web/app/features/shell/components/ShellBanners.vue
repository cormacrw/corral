<script setup lang="ts">
import { errorText } from '@corral/core'
import { settingsPath } from '~/utils/routes'
import type AppAlert from '~/components/app/AppAlert.vue'
import { useMutation, useQuery } from '@tanstack/vue-query'
import { patchProject, projectsQuery } from '~/queries/projects'
import { useLive } from '~/queries/stream'
import { liftUpdateHold as liftUpdateHoldMutation, resumeAll as resumeAllMutation, runnerQuery, statusQuery } from '~/queries/system'

// Shell-wide banners (design/app-shell.md), shared by the web and mobile
// layouts: kill switch, update hold, paused project, runner offline
const { connection } = useLive()
const route = useRoute()
const toast = useToast()
const status = useQuery(statusQuery()).data
const runner = useQuery(runnerQuery()).data
const projects = useQuery(projectsQuery()).data
const patching = useMutation(patchProject)
const resuming = useMutation(resumeAllMutation)
const lifting = useMutation(liftUpdateHoldMutation)

// Shown only when no runner at all is online; some offline is just the list
const runnerBanner = computed(() => {
  const runners = runner.value?.runners ?? []
  if (runners.some(r => r.needsUpdate) && !runners.some(r => !r.needsUpdate)) {
    return `The runner needs an update to protocol ${runner.value?.protocol}. Plan and live runs are unavailable until it reconnects.`
  }
  return runners.length > 1
    ? 'Every runner is offline. Plan and live runs are unavailable until one reconnects.'
    : 'The runner is offline. Plan and live runs are unavailable until it reconnects.'
})

const currentSlug = computed(() => typeof route.params.slug === 'string' ? route.params.slug : null)
const currentProject = computed(() => projects.value?.find(p => p.slug === currentSlug.value) ?? null)

async function attempt(failure: string, action: () => Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    toast.add({ title: failure, description: errorText(error), color: 'error' })
  }
}

// At most one shows, the most urgent
const banner = computed<InstanceType<typeof AppAlert>['$props'] & { 'data-testid'?: string } | null>(() => {
  if (status.value?.stopped) {
    return { color: 'error', variant: 'solid', icon: 'i-hugeicons-alert-diamond', title: 'Corral is stopped. No runs will start until you resume.', actions: [{ label: 'Resume everything', color: 'neutral', variant: 'solid', onClick: () => attempt('Could not resume', () => resuming.mutateAsync()) }] }
  }
  if (status.value?.updating) {
    return { color: 'info', variant: 'subtle', icon: 'i-hugeicons-download-04', title: 'Corral is waiting to update', actions: [{ label: 'Lift', color: 'neutral', variant: 'solid', onClick: () => attempt('Could not lift update hold', () => lifting.mutateAsync()) }] }
  }
  const project = currentProject.value
  if (project?.paused) {
    return { color: 'warning', variant: 'solid', icon: 'i-hugeicons-pause', title: `${project.name} is paused. No new runs will start; work already running will finish.`, actions: [{ label: 'Resume', color: 'neutral', variant: 'solid', onClick: () => attempt('Could not resume', () => patching.mutateAsync({ slug: project.slug, input: { paused: false } })) }] }
  }
  if (runner.value && !runner.value.online) {
    return { 'color': 'warning', 'variant': 'subtle', 'icon': 'i-hugeicons-server-stack-01', 'title': runnerBanner.value, 'data-testid': 'runner-offline-banner', 'actions': [{ label: 'Runners', color: 'neutral', variant: 'outline', to: settingsPath('runner') }] }
  }
  if (connection.value === 'reconnecting') {
    return { color: 'neutral', variant: 'subtle', icon: 'i-hugeicons-refresh', title: 'Reconnecting to Corral…' }
  }
  return null
})
</script>

<template>
  <AppAlert
    v-if="banner"
    v-bind="banner"
    class="shrink-0 rounded-none py-2"
    orientation="horizontal"
  />
</template>
