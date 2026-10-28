<script setup lang="ts">
import type { Plan, PlanMessage, PlanSessionDetail } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { projectColor } from '~/utils/labels'

// A Plan conversation (design/plan.md)
const route = useRoute()
const live = useLive()
// The PM by its current name and picture
const pm = computed(() => live.state.value.agents.find(a => a.role === 'pm') ?? null)
const flyout = useTaskFlyout()
const toast = useToast()
const id = computed(() => String(route.params.sessionId))
const session = ref<PlanSessionDetail | null>(null)
const error = ref<string | null>(null)
const text = ref('')
const taskRef = ref<string | null>(null)
const busy = ref(false)
const approving = ref<string | null>(null)
const project = computed(() => live.state.value.projects.find(p => p.id === session.value?.projectId) ?? null)
const runnerOffline = computed(() => live.state.value.loaded && !live.state.value.runner?.online)
useSeoMeta({ title: () => `${session.value?.title ?? 'Plan'} · Corral` })

async function load() {
  error.value = null
  try {
    session.value = await api.plan.session(id.value)
    if (session.value.unread) void api.plan.read(id.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
watch(id, () => void load(), { immediate: true })
onMounted(() => {
  const stop = live.subscribe((event) => {
    if (!session.value) return
    if (event.type === 'plan.message' && event.message.sessionId === session.value.id) {
      if (!session.value.messages.some(m => m.id === event.message.id)) session.value.messages.push(event.message)
    }
    if (event.type === 'plan.updated' && event.plan.sessionId === session.value.id) {
      const i = session.value.plans.findIndex(p => p.id === event.plan.id)
      if (i >= 0) session.value.plans.splice(i, 1, event.plan)
      else session.value.plans.push(event.plan)
    }
    if (event.type === 'plan.session' && event.session.id === session.value.id) {
      Object.assign(session.value, event.session)
    }
  })
  onBeforeUnmount(stop)
})

const planOf = (message: PlanMessage): Plan | null => session.value?.plans.find(p => p.id === message.planId) ?? null
const previousOf = (plan: Plan): Plan | null => session.value?.plans.find(p => p.version === plan.version - 1) ?? null
const backlog = computed(() => project.value ? (live.state.value.tasks[project.value.id] ?? []).filter(t => t.status === 'backlog') : [])

async function send(message: string) {
  if (!session.value) return
  busy.value = true
  try {
    await api.plan.message(session.value.id, message, taskRef.value ?? undefined)
    text.value = ''
    taskRef.value = null
  } catch (e) {
    toast.add({ title: 'Could not send', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    busy.value = false
  }
}
async function approve(plan: Plan, to: 'ready' | 'backlog') {
  approving.value = plan.id
  try {
    await api.plan.approve(plan.id, to)
  } catch (e) {
    toast.add({ title: 'Could not approve', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    approving.value = null
  }
}
const log = ref<HTMLElement | null>(null)
watch(() => session.value?.messages.length, async () => {
  await nextTick()
  if (log.value) log.value.scrollTop = log.value.scrollHeight
})
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <div class="flex h-full min-h-0">
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4 text-sm">
          <span
            v-if="project"
            class="size-2.5 rounded-full"
            :style="{ background: projectColor(project) }"
          />
          <span class="text-muted">{{ project?.name }}</span>
          <span class="truncate font-medium">{{ session?.title }}</span>
          <UButton
            to="/plan"
            label="New session"
            variant="ghost"
            color="neutral"
            size="sm"
            class="ms-auto"
          />
        </header>

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          class="m-4"
          :actions="[{ label: 'Retry', onClick: load }]"
        />
        <div
          v-else-if="!session"
          class="flex flex-col gap-3 p-6"
        >
          <USkeleton class="h-10 w-2/3" />
          <USkeleton class="h-24 w-full" />
        </div>
        <div
          v-else
          ref="log"
          role="log"
          aria-live="polite"
          class="min-h-0 flex-1 overflow-y-auto p-4"
        >
          <div class="mx-auto flex w-full max-w-[768px] flex-col gap-4">
            <div
              v-for="message in session.messages"
              :key="message.id"
              :class="['flex', message.role === 'human' ? 'justify-end' : 'justify-start']"
            >
              <div
                v-if="message.role === 'human'"
                class="max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-sm whitespace-pre-wrap"
              >
                {{ message.text }}
              </div>
              <div
                v-else
                class="flex max-w-full min-w-0 gap-2"
              >
                <AgentAvatar
                  :name="pm?.name ?? 'PM'"
                  size="sm"
                />
                <div class="flex min-w-0 flex-col gap-2">
                  <span class="text-xs text-muted">{{ pm?.name ?? 'PM' }} · PM</span>
                  <UAlert
                    v-if="message.kind === 'error'"
                    color="error"
                    variant="subtle"
                    :title="message.text"
                    :actions="[{ label: 'Retry', onClick: () => send('Please continue.') }]"
                  />
                  <div
                    v-else
                    :class="['text-sm', message.kind === 'question' && 'rounded-md border border-info/40 bg-info/5 px-3 py-2']"
                  >
                    <span
                      v-if="message.kind === 'question'"
                      class="mb-1 block text-xs font-medium text-info"
                    >Question</span>
                    <MarkdownText :text="message.text" />
                  </div>
                  <PlanCard
                    v-if="planOf(message)"
                    :plan="planOf(message)!"
                    :previous="previousOf(planOf(message)!)"
                    :busy="approving === planOf(message)!.id"
                    @approve="approve(planOf(message)!, $event)"
                    @open="flyout.toggle($event)"
                  />
                </div>
              </div>
            </div>
            <p
              v-if="session.activeRunId"
              class="flex items-center gap-2 text-sm text-muted"
            >
              <span class="relative flex size-2">
                <span class="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75 motion-reduce:hidden" />
                <span class="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              Reading the code, wiki and board…
            </p>
          </div>
        </div>

        <div class="shrink-0 border-t border-default p-3">
          <div class="mx-auto w-full max-w-[768px]">
            <UAlert
              v-if="runnerOffline"
              color="warning"
              variant="subtle"
              icon="i-lucide-server-off"
              title="Plan needs the runner. It's offline."
              class="mb-2"
            />
            <PromptComposer
              v-model="text"
              :placeholder="`Reply to ${pm?.name ?? 'the PM'}…`"
              :disabled="runnerOffline || Boolean(session?.activeRunId)"
              :busy="busy"
              :allow-empty="taskRef !== null"
              @submit="send"
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
                    Refining {{ taskRef }}
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
              </template>
            </PromptComposer>
          </div>
        </div>
      </div>
      <TaskFlyout />
    </div>
  </UDashboardPanel>
</template>
