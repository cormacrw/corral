<script setup lang="ts">
import type { Inbox, InboxActionInput, InboxItem, Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { timeAgo } from '~/utils/labels'

// The Inbox (design/inbox.md, D11): list, selected item, action tray, task flyout
const route = useRoute()
const router = useRouter()
const live = useLive()
const flyout = useTaskFlyout()
const toast = useToast()
useSeoMeta({ title: 'Inbox · Corral' })

const inbox = ref<Inbox | null>(null)
const error = ref<string | null>(null)
const tab = ref<'needsYou' | 'activity' | 'resolved'>('needsYou')
const search = ref('')
const action = ref<InboxActionInput['action'] | null>(null)
const resolveTo = ref<'backlog' | 'ready' | 'in_progress'>('in_progress')
const text = ref('')
const busy = ref(false)
const actionError = ref<string | null>(null)
const task = ref<Task | null>(null)
const showTask = ref(true)

async function load() {
  error.value = null
  try {
    inbox.value = await api.inbox.get()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
onMounted(() => {
  void load()
  const stop = live.subscribe((event) => {
    if (['task.updated', 'task.deleted', 'task.created', 'run.updated'].includes(event.type)) void load()
  })
  onBeforeUnmount(stop)
})

const items = computed<InboxItem[]>(() => (inbox.value?.[tab.value] ?? []).filter(i => !search.value || `${i.taskRef} ${i.subject} ${i.preview}`.toLowerCase().includes(search.value.toLowerCase())))
const selectedId = computed(() => typeof route.params.itemId === 'string' ? route.params.itemId : null)
const selected = computed<InboxItem | null>(() => {
  if (!inbox.value || !selectedId.value) return null
  return [...inbox.value.needsYou, ...inbox.value.activity, ...inbox.value.resolved].find(i => i.id === selectedId.value) ?? null
})
const alreadyResolved = computed(() => selected.value !== null && selected.value.type !== 'activity' && !inbox.value?.needsYou.some(i => i.id === selected.value!.id))
watch(selected, async (item) => {
  action.value = null
  text.value = ''
  actionError.value = null
  task.value = item ? await api.tasks.byRef(item.taskRef).catch(() => null) : null
  if (item && showTask.value) flyout.open(item.taskRef)
}, { immediate: true })
function select(item: InboxItem) {
  void router.push(`/inbox/${item.id}`)
}
function toggleTask() {
  showTask.value = !showTask.value
  if (showTask.value && selected.value) flyout.open(selected.value.taskRef)
  else flyout.close()
}

const actions = computed(() => {
  if (!selected.value) return []
  switch (selected.value.type) {
    case 'human_review': return [{ value: 'approve', label: 'Approve and merge', icon: 'i-lucide-check' }, { value: 'request_changes', label: 'Request changes', icon: 'i-lucide-pencil' }]
    case 'question':
    case 'blocked': return [{ value: 'clarify', label: 'Clarify and continue', icon: 'i-lucide-message-circle' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-lucide-undo-2' }, { value: 'delete', label: 'Delete task', icon: 'i-lucide-trash-2' }]
    case 'failed': return [{ value: 'resolve', label: 'Retry', icon: 'i-lucide-rotate-ccw' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-lucide-undo-2' }, { value: 'delete', label: 'Delete task', icon: 'i-lucide-trash-2' }]
    default: return []
  }
})
const needsText = computed(() => action.value === 'request_changes' || action.value === 'clarify')
const placeholder = computed(() => {
  switch (action.value) {
    case 'request_changes': return `What should ${live.state.value.agents.find(a => a.role === 'developer')?.name ?? 'the developer'} change?`
    case 'clarify': return 'Your answer or guidance for the developer'
    case 'delete': return 'Reason for deleting (optional)'
    case null: return `Reply to ${selected.value?.sender.name ?? 'the agent'}…`
    default: return 'Optional note'
  }
})
const submitLabel = computed(() => action.value ? (actions.value.find(a => a.value === action.value)?.label ?? 'Send') : '')

async function submit(message: string) {
  if (!selected.value) return
  busy.value = true
  actionError.value = null
  try {
    if (!action.value) {
      if (task.value) await api.tasks.comment(live.state.value.projects.find(p => p.id === task.value!.projectId)!.slug, task.value.number, message)
    } else {
      const input: InboxActionInput = action.value === 'clarify'
        ? { action: 'clarify', text: message }
        : action.value === 'request_changes'
          ? { action: 'request_changes', text: message }
          : action.value === 'resolve'
            ? { action: 'resolve', to: resolveTo.value, ...(message && { text: message }) }
            : action.value === 'delete'
              ? { action: 'delete', ...(message && { text: message }) }
              : action.value === 'send_back' ? { action: 'send_back' } : { action: 'approve' }
      await api.inbox.act(selected.value.taskId, input)
      toast.add({ title: 'Done', description: submitLabel.value, color: 'success' })
    }
    text.value = ''
    action.value = null
    await load()
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
const typeBadge = (type: InboxItem['type']) => ({
  human_review: { label: 'Human review', color: 'warning' as const },
  question: { label: 'Question', color: 'info' as const },
  blocked: { label: 'Blocked', color: 'error' as const },
  failed: { label: 'Failed', color: 'error' as const },
  activity: { label: 'Activity', color: 'neutral' as const }
})[type]
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <div class="flex h-full min-h-0 max-md:flex-col">
      <div class="flex w-[380px] shrink-0 flex-col border-e border-default max-md:max-h-[360px] max-md:w-full max-md:border-e-0 max-md:border-b">
        <div class="flex flex-col gap-2 border-b border-default p-3">
          <UInput
            v-model="search"
            placeholder="Search"
            icon="i-lucide-search"
            size="sm"
          />
          <UTabs
            v-model="tab"
            :items="[
              { label: `Needs you (${inbox?.needsYou.length ?? 0})`, value: 'needsYou', icon: 'i-lucide-inbox' },
              { label: 'Activity', value: 'activity', icon: 'i-lucide-activity' },
              { label: `Resolved (${inbox?.resolved.length ?? 0})`, value: 'resolved', icon: 'i-lucide-circle-check' }
            ]"
            size="xs"
            :content="false"
          />
        </div>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          class="m-3"
          :actions="[{ label: 'Retry', onClick: load }]"
        />
        <div
          v-else-if="!inbox"
          class="flex flex-col gap-2 p-3"
        >
          <USkeleton
            v-for="i in 4"
            :key="i"
            class="h-16 w-full"
          />
        </div>
        <ul
          v-else
          class="min-h-0 flex-1 overflow-y-auto"
        >
          <li
            v-for="item in items"
            :key="item.id"
          >
            <button
              type="button"
              :class="['flex w-full gap-2 border-b border-default px-3 py-2 text-start', selectedId === item.id && 'bg-elevated']"
              @click="select(item)"
            >
              <AgentAvatar
                :name="item.sender.name"
                size="xs"
              />
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2 text-xs text-muted">
                  <span class="font-medium text-default">{{ item.sender.name }}</span>
                  <span class="ms-auto">{{ timeAgo(item.at) }}</span>
                </span>
                <span class="block truncate text-sm font-medium">{{ item.subject }}</span>
                <span class="line-clamp-2 text-xs text-muted">{{ item.preview }}</span>
                <span class="mt-1 flex items-center gap-2">
                  <UBadge
                    :label="typeBadge(item.type).label"
                    :color="typeBadge(item.type).color"
                    variant="subtle"
                    size="xs"
                  />
                  <span class="flex items-center gap-1 text-xs text-muted">
                    <span
                      class="size-2 rounded-full"
                      :style="{ background: item.project.thumbnailColor ?? '#64748b' }"
                    />{{ item.project.name }}
                  </span>
                </span>
              </span>
            </button>
          </li>
          <li
            v-if="items.length === 0"
            class="p-6 text-center text-sm text-muted"
          >
            All clear. Nothing here right now.
          </li>
        </ul>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <template v-if="selected">
          <header class="flex items-start gap-3 border-b border-default p-4">
            <AgentAvatar
              :name="selected.sender.name"
              size="md"
            />
            <div class="min-w-0 flex-1">
              <h1 class="truncate font-medium">
                {{ selected.subject }}
              </h1>
              <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
                <UBadge
                  :label="typeBadge(selected.type).label"
                  :color="typeBadge(selected.type).color"
                  variant="subtle"
                  size="xs"
                />
                <span>{{ selected.project.name }} · {{ selected.taskRef }}</span>
                <span>{{ selected.sender.name }} · {{ selected.sender.role }} · {{ timeAgo(selected.at) }}</span>
              </div>
            </div>
            <UButton
              label="Task details"
              variant="outline"
              color="neutral"
              size="sm"
              :aria-pressed="showTask"
              @click="toggleTask"
            />
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <div class="mx-auto flex max-w-[720px] flex-col gap-4">
              <UAlert
                v-if="selected.resolution"
                color="success"
                variant="subtle"
                icon="i-lucide-circle-check"
                title="Resolved"
                :description="selected.resolution"
              />
              <UAlert
                v-else-if="alreadyResolved"
                color="neutral"
                variant="subtle"
                title="Already resolved"
                description="This task changed status elsewhere."
              />
              <p class="text-sm whitespace-pre-wrap">
                {{ selected.body }}
              </p>
              <a
                v-if="selected.prUrl"
                :href="selected.prUrl"
                target="_blank"
                rel="noopener"
                class="text-sm text-primary hover:underline"
              >Open PR</a>
              <template v-if="selected.type === 'human_review' && task">
                <div
                  v-if="task.gateChecks?.length"
                  class="flex flex-wrap gap-1"
                >
                  <UBadge
                    v-for="check in task.gateChecks"
                    :key="check.name"
                    :label="`✓ ${check.name}`"
                    color="success"
                    variant="subtle"
                    size="xs"
                  />
                </div>
                <EvidenceList
                  :evidence="[]"
                  :criteria="task.acceptanceCriteria"
                  :reviews="task.latestReview ? [task.latestReview] : []"
                />
                <p class="text-xs text-muted">
                  Open Task details for the evidence files.
                </p>
              </template>
              <NuxtLink
                v-if="selected.type === 'activity'"
                :to="`/tasks/${selected.taskRef}`"
                class="text-sm text-primary hover:underline"
              >Open task</NuxtLink>
            </div>
          </div>
          <div
            v-if="selected.type !== 'activity' && !selected.resolution && !alreadyResolved"
            class="shrink-0 border-t border-default p-3"
          >
            <div class="mx-auto flex max-w-[720px] flex-col gap-2">
              <div
                role="radiogroup"
                aria-label="Quick actions"
                class="flex flex-wrap gap-1.5"
              >
                <UButton
                  v-for="a in actions"
                  :key="a.value"
                  :label="a.label"
                  :icon="a.icon"
                  size="xs"
                  role="radio"
                  :aria-checked="action === a.value"
                  :variant="action === a.value ? 'subtle' : 'outline'"
                  :color="a.value === 'delete' ? 'error' : action === a.value ? 'primary' : 'neutral'"
                  @click="action = action === a.value ? null : (a.value as InboxActionInput['action'])"
                />
                <USelectMenu
                  v-if="action === 'resolve'"
                  v-model="resolveTo"
                  :items="[{ label: 'In progress', value: 'in_progress' }, { label: 'Ready', value: 'ready' }, { label: 'Backlog', value: 'backlog' }]"
                  value-key="value"
                  size="xs"
                  :search-input="false"
                />
              </div>
              <UAlert
                v-if="actionError"
                color="error"
                variant="subtle"
                :title="actionError"
              />
              <PromptComposer
                v-model="text"
                :placeholder="placeholder"
                :submit-label="submitLabel"
                :submit-color="action === 'delete' ? 'error' : 'primary'"
                :allow-empty="action !== null && !needsText"
                :busy="busy"
                @submit="submit"
              />
            </div>
          </div>
        </template>
        <div
          v-else
          class="flex flex-1 items-center justify-center p-6 text-sm text-muted"
        >
          Pick an item.
        </div>
      </div>
      <TaskFlyout />
    </div>
  </UDashboardPanel>
</template>
