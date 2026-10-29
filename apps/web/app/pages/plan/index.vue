<script setup lang="ts">
import { api } from '~/composables/useApi'
import { initials, projectColor, timeAgo } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'

// Plan, new session (design/plan.md)
const live = useLive()
// The PM by its current name and picture
const pm = computed(() => live.state.value.agents.find(a => a.role === 'pm') ?? null)
const router = useRouter()
const route = useRoute()
const toast = useToast()
useSeoMeta({ title: 'Plan · Corral' })

const lastProject = useLocalStorage<string | null>('corral.plan.project', null)
const projectId = ref<string | null>(typeof route.query.project === 'string' ? route.query.project : lastProject.value)
const project = computed(() => live.state.value.projects.find(p => p.id === projectId.value) ?? live.state.value.projects[0] ?? null)
watch(project, (p) => {
  if (p) lastProject.value = p.id
}, { immediate: true })
const text = ref('')
const taskRef = ref<string | null>(null)
const busy = ref(false)
const runnerOffline = computed(() => live.state.value.loaded && !live.state.value.runner?.online)

const backlog = computed(() => project.value ? (live.state.value.tasks[project.value.id] ?? []).filter(t => t.status === 'backlog') : [])
const recent = computed(() => live.state.value.planSessions.slice(0, 4))
const suggestions = computed(() => taskRef.value
  ? ['Tighten the acceptance criteria', 'Split it into smaller tasks', 'Check its dependencies']
  : ['Plan a new feature', 'Break an epic into tasks', 'What’s blocking progress?'])

// Resolves false when not started, so the composer keeps its images
async function start(message: string): Promise<boolean> {
  if (!project.value) return false
  busy.value = true
  try {
    const session = await api.plan.start(project.value.id, message, taskRef.value ?? undefined)
    await router.push(`/plan/${session.id}`)
    return true
  } catch (e) {
    toast.add({ title: 'Could not start the session', description: e instanceof Error ? e.message : String(e), color: 'error' })
    return false
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UDashboardPanel>
    <PlanTabs />
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6">
      <div class="flex w-full max-w-[720px] flex-col gap-6">
        <div class="flex flex-col items-center gap-2 text-center">
          <AgentAvatar
            :name="pm?.name ?? 'PM'"
            size="3xl"
          />
          <h1 class="text-2xl font-semibold">
            What should we plan?
          </h1>
          <p class="text-sm text-muted">
            {{ pm?.name ?? 'The PM' }} reads {{ project?.name ?? 'the project' }}'s code, wiki and board before answering. Nothing reaches the board until you approve it.
          </p>
        </div>

        <UAlert
          v-if="runnerOffline"
          color="warning"
          variant="subtle"
          icon="i-lucide-server-off"
          title="Plan needs the runner. It's offline."
          description="Start the runner, then try again."
        />

        <PromptComposer
          v-model="text"
          placeholder="Describe what you want to build…"
          :disabled="runnerOffline || !project"
          :busy="busy"
          :allow-empty="taskRef !== null"
          :rows="3"
          :project="project?.slug"
          @submit="start"
        >
          <template #header>
            <div
              v-if="taskRef"
              class="flex items-center gap-2 text-xs"
            >
              <UBadge
                variant="subtle"
                color="primary"
              >
                Refining <NuxtLink
                  :to="{ query: { ...route.query, task: taskRef } }"
                  class="ms-1 underline"
                >{{ taskRef }}</NuxtLink>
              </UBadge>
              <UButton
                icon="i-lucide-x"
                size="xs"
                variant="ghost"
                color="neutral"
                aria-label="Remove attached task"
                @click="taskRef = null"
              />
            </div>
          </template>
          <template #tools>
            <USelectMenu
              :model-value="project?.id"
              :items="live.state.value.projects.map(p => ({ label: p.name, value: p.id, color: projectColor(p), initial: initials(p.name) }))"
              value-key="value"
              size="xs"
              variant="ghost"
              :search-input="false"
              aria-label="Project"
              :ui="{ content: 'w-80 max-w-[calc(100vw-2rem)]', base: 'max-w-56' }"
              @update:model-value="projectId = $event as string"
            >
              <template #leading>
                <span
                  class="size-2.5 rounded-full"
                  :style="{ background: project ? projectColor(project) : '#999' }"
                />
              </template>
            </USelectMenu>
            <USelectMenu
              :model-value="taskRef ?? undefined"
              :items="backlog.map(t => ({ label: `${t.ref} ${t.title}`, value: t.ref }))"
              value-key="value"
              size="xs"
              variant="ghost"
              icon="i-lucide-list-checks"
              placeholder="Refine a task"
              :search-input="{ placeholder: 'Search Backlog' }"
              aria-label="Refine a task"
              :ui="{ content: 'w-80 max-w-[calc(100vw-2rem)]', base: 'max-w-56' }"
              @update:model-value="taskRef = ($event as string | null)"
            />
            <USelectMenu
              :items="live.state.value.planSessions.map(s => ({ label: s.title, value: s.id }))"
              value-key="value"
              size="xs"
              variant="ghost"
              icon="i-lucide-history"
              placeholder="Resume"
              :search-input="{ placeholder: 'Search sessions' }"
              aria-label="Resume a session"
              :ui="{ content: 'w-80 max-w-[calc(100vw-2rem)]', base: 'max-w-56' }"
              @update:model-value="$router.push(`/plan/${$event}`)"
            />
          </template>
        </PromptComposer>

        <div class="flex flex-wrap justify-center gap-2">
          <UButton
            v-for="s in suggestions"
            :key="s"
            :label="s"
            size="xs"
            variant="outline"
            color="neutral"
            class="rounded-full"
            @click="text = s"
          />
        </div>

        <section
          v-if="recent.length > 0"
          class="rounded-lg border border-default"
        >
          <h2 class="border-b border-default px-3 py-2 text-xs font-medium text-muted">
            Recent sessions
          </h2>
          <ul class="divide-y divide-default">
            <li
              v-for="session in recent"
              :key="session.id"
            >
              <NuxtLink
                :to="`/plan/${session.id}`"
                class="flex items-center gap-3 px-3 py-2 text-sm hover:bg-elevated"
              >
                <span
                  :class="['size-2 shrink-0 rounded-full', session.unread ? 'bg-primary' : 'bg-transparent']"
                  :aria-label="session.unread ? 'Unread' : undefined"
                />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2">
                    <span class="truncate font-medium">{{ session.title }}</span>
                    <UBadge
                      v-if="session.status === 'needs_approval'"
                      label="Needs approval"
                      color="primary"
                      variant="subtle"
                      size="xs"
                    />
                    <UBadge
                      v-else-if="session.status === 'question'"
                      label="Question"
                      color="info"
                      variant="subtle"
                      size="xs"
                    />
                  </span>
                  <span class="block truncate text-xs text-muted">
                    {{ live.state.value.projects.find(p => p.id === session.projectId)?.name }} · {{ markdownToPlainText(session.preview) }}
                  </span>
                </span>
                <span class="text-xs text-dimmed">{{ timeAgo(session.updatedAt) }}</span>
              </NuxtLink>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </UDashboardPanel>
</template>
