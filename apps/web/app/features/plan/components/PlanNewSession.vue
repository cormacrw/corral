<script setup lang="ts">
import { computed, provide } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { AgentRuntime } from '@corral/contracts'
import { FLYOUT_SHEETS } from '~/features/tasks/composables/useTaskFlyout'
import { planDraftsQuery, planSessionsQuery } from '~/queries/plan'
import { projectColor } from '~/utils/labels'
import { usePlanRunner } from '~/features/plan/composables/usePlanRunner'
import { usePlanStart } from '~/features/plan/composables/usePlanStart'

// Plan, new session (design/plan.md): the prompt that starts a session, and
// the project's Drafts under it
const props = defineProps<{ tagline: string, initialProjectId?: string }>()
const shell = useShell()
const router = useRouter()
const device = useDevice()
const { pm, offline, unavailable } = usePlanRunner()
const { projectId, project, runtime, runtimeItems, lastRuntime, restoredImages, text, taskRef, busy, start } = usePlanStart(() => props.initialProjectId)
// The attached task and its epic open beside the composer, or over it on
// phones, which keeps the draft that going to the task's page would lose
provide(FLYOUT_SHEETS, true)

const projectItems = computed(() => [{ label: 'Global', value: 'global', project: null }, ...shell.projects.map(p => ({ label: p.name, value: p.id, project: p }))])
const sessions = useQuery(planSessionsQuery()).data
const sessionItems = computed(() => (sessions.value ?? []).map(s => ({ label: `${s.title} · ${shell.projects.find(p => p.id === s.projectId)?.name ?? 'Global'}`, value: s.id })))
// The project's Drafts by session, kept current by plan.drafts, which
// follows every propose, approve and discard
const draftsQuery = useQuery(computed(() => ({ ...planDraftsQuery(project.value?.slug ?? ''), enabled: Boolean(project.value) })))
const drafts = computed(() => draftsQuery.data.value ?? [])
const placeholder = computed(() => {
  if (offline.value && device.isMobile.value) return unavailable.value
  return taskRef.value ? `What should change about ${taskRef.value}? (optional)` : 'Describe what you want to build…'
})
</script>

<template>
  <div class="flex min-h-0 flex-1 max-[1100px]:flex-col">
    <div :class="['flex min-w-0 flex-1 flex-col items-center', device.isMobile.value ? 'shrink-0 justify-start p-4' : 'min-h-0 overflow-y-auto overscroll-contain p-6']">
      <!-- my-auto, not justify-center: a tall page must still scroll to its top -->
      <div :class="['flex w-full max-w-[720px] flex-col gap-6', !device.isMobile.value && 'my-auto']">
        <div class="flex flex-col items-center gap-2 text-center">
          <AgentAvatar
            :name="pm?.name ?? 'PM'"
            size="4xl"
          />
          <h1 class="text-2xl font-semibold">
            {{ props.tagline }}
          </h1>
        </div>

        <PlanRunnerOffline hint="Start the runner, then try again." />

        <PromptComposer
          v-model="text"
          :initial-images="restoredImages"
          :placeholder="placeholder"
          :disabled="offline"
          :busy="busy"
          :allow-empty="taskRef !== null"
          :rows="3"
          :project="project?.slug"
          draft-key="plan:new"
          @submit="start"
        >
          <template #header>
            <PlanAttachedTask
              v-if="taskRef"
              :task-ref="taskRef"
              @remove="taskRef = null"
            />
          </template>
          <template #tools>
            <AppSelectMenu
              :model-value="project?.id ?? 'global'"
              :items="projectItems"
              value-key="value"
              size="xs"
              variant="ghost"
              :search-input="false"
              aria-label="Project"
              content-class="w-80 max-w-[calc(100vw-2rem)]"
              class="w-auto max-w-56"
              @update:model-value="projectId = $event === 'global' ? null : $event as string"
            >
              <template #item-leading="{ item }">
                <ProjectThumbnail
                  v-if="item.project"
                  :project="item.project"
                  :size="20"
                />
              </template>
              <template #leading>
                <span
                  class="size-2.5 rounded-full"
                  :style="{ background: project ? projectColor(project) : 'var(--muted-foreground)' }"
                />
              </template>
            </AppSelectMenu>
            <AppSelectMenu
              :model-value="runtime"
              :items="runtimeItems"
              value-key="value"
              size="xs"
              variant="ghost"
              icon="i-ri-cpu-line"
              :search-input="false"
              aria-label="Runtime"
              data-testid="plan-runtime"
              content-class="w-48"
              class="w-auto max-w-40"
              @update:model-value="lastRuntime = $event as AgentRuntime"
            />
            <PlanRefineMenu
              v-model="taskRef"
              :project="project"
            />
            <AppSelectMenu
              v-if="!device.isMobile.value"
              :items="sessionItems"
              value-key="value"
              size="xs"
              variant="ghost"
              icon="i-ri-history-line"
              placeholder="Resume"
              :search-input="{ placeholder: 'Search sessions' }"
              aria-label="Resume a session"
              content-class="w-80 max-w-[calc(100vw-2rem)]"
              class="w-auto max-w-56"
              @update:model-value="router.push(`/plan/${$event}`)"
            />
          </template>
        </PromptComposer>

        <p
          v-if="offline && device.isMobile.value"
          class="-mt-3 text-xs text-muted-foreground"
        >
          You can still read the Inbox, the board and past runs.
        </p>

        <PlanDrafts
          :sessions="drafts"
          :mobile="device.isMobile.value"
        />
      </div>
    </div>
    <PlanSheets
      v-if="device.isMobile.value"
      :plan="null"
      :previous="null"
      :busy="false"
    />
    <TaskFlyout v-else />
  </div>
</template>
