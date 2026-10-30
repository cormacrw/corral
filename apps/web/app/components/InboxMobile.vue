<script setup lang="ts">
import { needsAttention } from '@corral/contracts'
import type { Evidence, Inbox, InboxActionInput, InboxItem, PlanThreadItem, Review, Task, TaskInboxItem, ReleaseNotesItem } from '@corral/contracts'
import { ROLE, timeAgo, type Color } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'
import { moveRadioSelection } from '~/utils/radio'

// The Inbox on a phone (design/inbox.md, design/mobile.md): /inbox is the
// list and /inbox/:itemId the item, each a screen of its own. The page owns
// the data and the actions; this lays them out.
type Action = InboxActionInput['action']
const props = defineProps<{
  planThread: PlanThreadItem | null
  onRefresh: () => Promise<void>
  inbox: Inbox | null
  error: string | null
  items: InboxItem[]
  selectedId: string | null
  selected: TaskInboxItem | ReleaseNotesItem | null
  alreadyResolved: boolean
  task: Task | null
  isSpike: boolean
  evidence: Evidence[]
  reviews: Review[]
  actions: { value: string, label: string, icon: string }[]
  placeholder: string
  submitLabel: string
  needsText: boolean
  busy: boolean
  actionError: string | null
  typeBadge: (type: InboxItem['type']) => { label: string, color: Color }
  onSubmit: (text: string) => Promise<boolean>
  onRetry: () => unknown
}>()
const checkedHumanCriteria = defineModel<string[]>('checkedHumanCriteria', { required: true })
const tab = defineModel<'needsYou' | 'activity' | 'resolved'>('tab', { required: true })
const search = defineModel<string>('search', { required: true })
const action = defineModel<Action | null>('action', { required: true })
const resolveTo = defineModel<'backlog' | 'ready' | 'in_progress'>('resolveTo', { required: true })
const text = defineModel<string>('text', { required: true })

const searching = ref(Boolean(search.value))
function toggleSearch() {
  searching.value = !searching.value
  if (!searching.value) search.value = ''
}

// Questions keep their composer-only answer flow; the page selects clarify.
const isQuestion = computed(() => props.selected?.type === 'question')
const sender = computed(() => props.selected?.sender.name ?? 'the agent')
const composerPlaceholder = computed(() => isQuestion.value && action.value === 'clarify' ? `Your answer for ${sender.value}` : props.placeholder)
const composerLabel = computed(() => isQuestion.value && action.value === 'clarify' ? 'Send answer' : props.submitLabel)
const prLabel = computed(() => {
  const number = props.selected?.prUrl?.match(/\/pull\/(\d+)/)?.[1]
  return number ? `#${number}` : 'Open PR'
})
const role = (r: InboxItem['sender']['role']) => r === 'system' ? 'System' : ROLE[r]
const canAct = computed(() => props.selected !== null && props.selected.type !== 'activity' && props.selected.type !== 'release_notes' && !props.selected.resolution && !props.alreadyResolved)
// A thread being deleted leaves the list at once, while its Undo toast shows
const deleting = usePlanThreadDelete()
const isHidden = (item: InboxItem) => item.type === 'plan_thread' && deleting.pending.value.includes(item.sessionId)
const listed = computed(() => props.items.filter(i => !isHidden(i)))
// Server order: newest first, task items and threads together (D11)
const tabs = computed(() => [
  { label: 'Inbox', value: 'needsYou', icon: 'i-lucide-inbox', count: (props.inbox?.needsYou ?? []).filter(i => !isHidden(i) && needsAttention(i)).length },
  { label: 'Activity', value: 'activity', icon: 'i-lucide-activity', count: null },
  { label: 'Resolved', value: 'resolved', icon: 'i-lucide-circle-check', count: props.inbox?.resolved.length ?? 0 }
])
</script>

<template>
  <InboxMobilePlanThread
    v-if="planThread"
    :key="planThread.sessionId"
    :item="planThread"
    :on-refresh="onRefresh"
  />
  <div
    v-else-if="selected?.type === 'release_notes'"
    class="flex h-full min-h-0 flex-col"
  >
    <MobilePageHeader compact />
    <InboxReleaseNotes
      :item="selected"
      @refresh="onRefresh"
    />
  </div>
  <!-- Task items keep their message, context and tray. -->
  <div
    v-else-if="selectedId"
    class="flex h-full min-h-0 flex-col"
    data-testid="inbox-item"
  >
    <MobilePageHeader compact>
      <template #actions>
        <UButton
          v-if="selected"
          :to="`/tasks/${selected.taskRef}`"
          label="Task"
          icon="i-lucide-list"
          variant="ghost"
          color="neutral"
        />
      </template>
    </MobilePageHeader>
    <template v-if="selected">
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <div class="flex flex-col gap-4">
          <div class="flex gap-3">
            <AgentAvatar
              :name="selected.sender.name"
              size="md"
            />
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <h2 class="text-lg leading-tight font-semibold text-highlighted">
                {{ selected.subject }}
              </h2>
              <span class="flex items-center gap-2 text-xs text-muted">
                <UBadge
                  :label="typeBadge(selected.type).label"
                  :color="typeBadge(selected.type).color"
                  variant="subtle"
                  size="sm"
                />
                <span class="flex items-center gap-1">
                  <ProjectThumbnail
                    :project="selected.project"
                    :size="16"
                  />{{ selected.project.name }}
                </span>
              </span>
              <span class="text-xs text-muted">
                <span class="font-medium text-default">{{ selected.sender.name }}</span> · {{ role(selected.sender.role) }} · {{ timeAgo(selected.at) }}
              </span>
            </div>
          </div>
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
          <MarkdownText
            :text="selected.body"
            class="text-base"
          />
          <div
            v-if="!isSpike && (selected.prUrl || (selected.type === 'human_review' && task?.gateChecks?.length))"
            class="flex flex-wrap gap-1.5"
          >
            <UButton
              v-if="selected.prUrl"
              :to="selected.prUrl"
              target="_blank"
              :label="prLabel"
              icon="i-lucide-git-pull-request"
              color="neutral"
              variant="outline"
              size="xs"
            />
            <template v-if="selected.type === 'human_review'">
              <UBadge
                v-for="check in task?.gateChecks ?? []"
                :key="check.name"
                :label="check.name"
                icon="i-lucide-check"
                color="success"
                variant="subtle"
              />
            </template>
          </div>
          <EvidenceList
            v-if="selected.type === 'human_review' && task"
            v-model:checked="checkedHumanCriteria"
            :evidence="evidence"
            human-checklist
            :criteria="task.acceptanceCriteria"
            :reviews="reviews.length > 0 ? reviews : task.latestReview ? [task.latestReview] : []"
          />
          <UButton
            v-if="selected.type === 'activity'"
            :to="`/tasks/${selected.taskRef}`"
            label="Open task"
            color="neutral"
            variant="outline"
            class="self-start"
          />
        </div>
      </div>
      <div
        v-if="canAct"
        class="flex shrink-0 flex-col gap-2 border-t border-default p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        data-testid="inbox-tray"
      >
        <div
          v-if="!isQuestion"
          role="radiogroup"
          aria-label="Quick actions"
          class="flex flex-wrap gap-2"
          @keydown="moveRadioSelection"
        >
          <UButton
            v-for="a in actions"
            :key="a.value"
            :label="a.label"
            :icon="a.icon"
            size="md"
            role="radio"
            class="rounded-full"
            :aria-checked="action === a.value"
            :tabindex="action === a.value ? 0 : -1"
            :variant="action === a.value ? 'subtle' : 'outline'"
            :color="a.value === 'delete' && action === a.value ? 'error' : action === a.value ? 'primary' : 'neutral'"
            @click="action = (a.value as Action)"
          />
          <USelectMenu
            v-if="action === 'resolve'"
            v-model="resolveTo"
            :items="[{ label: 'In progress', value: 'in_progress' }, { label: 'Ready', value: 'ready' }, { label: 'Backlog', value: 'backlog' }]"
            value-key="value"
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
          :placeholder="composerPlaceholder"
          :submit-label="composerLabel"
          :submit-color="action === 'delete' ? 'error' : 'primary'"
          :allow-empty="action !== null && !needsText"
          :busy="busy"
          :project="selected.project.slug"
          @submit="onSubmit"
        />
      </div>
    </template>
    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      :title="error"
      class="m-4"
      :actions="[{ label: 'Retry', onClick: onRetry }]"
    />
    <div
      v-else-if="!inbox"
      class="flex flex-col gap-3 p-4"
    >
      <USkeleton class="h-12 w-full" />
      <USkeleton class="h-32 w-full" />
    </div>
    <div
      v-else
      class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted"
    >
      This item isn't in your Inbox any more.
      <UButton
        to="/inbox"
        label="Back to Inbox"
        color="neutral"
        variant="outline"
      />
    </div>
  </div>

  <!-- The list -->
  <div
    v-else
    class="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain"
    data-testid="inbox-list"
  >
    <div class="flex shrink-0 flex-col gap-3 border-b border-default p-3">
      <UInput
        v-if="searching"
        v-model="search"
        placeholder="Search"
        icon="i-lucide-search"
        autofocus
      />
      <div class="flex items-center gap-2">
        <UTabs
          v-model="tab"
          :items="tabs"
          :content="false"
          :ui="{ trigger: 'gap-1 px-1.5', label: 'overflow-visible', leadingIcon: 'max-[375px]:hidden' }"
          class="min-w-0 flex-1"
        >
          <template #trailing="{ item }">
            <span
              v-if="item.count !== null"
              class="text-xs opacity-75"
            >{{ item.count }}</span>
          </template>
        </UTabs>
        <UButton
          icon="i-lucide-search"
          variant="ghost"
          color="neutral"
          aria-label="Search the Inbox"
          :aria-pressed="searching"
          @click="toggleSearch"
        />
      </div>
    </div>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error"
      class="m-4"
      :actions="[{ label: 'Retry', onClick: onRetry }]"
    />
    <div
      v-else-if="!inbox"
      class="flex flex-col gap-3 p-4"
    >
      <USkeleton
        v-for="i in 4"
        :key="i"
        class="h-24 w-full"
      />
    </div>
    <ul
      v-else
      class="shrink-0"
    >
      <li
        v-for="item in listed"
        :key="item.id"
      >
        <!-- Only Plan threads swipe to delete; task items are resolved from their screen -->
        <SwipeToDelete
          v-if="item.type === 'plan_thread'"
          @delete="deleting.remove(item.sessionId, props.onRefresh)"
        >
          <NuxtLink
            :to="`/inbox/${item.id}`"
            draggable="false"
            class="flex gap-3 border-b border-default px-4 py-3 active:bg-elevated"
          >
            <PlanThreadRow
              :item="item"
              mobile
            />
          </NuxtLink>
        </SwipeToDelete>
        <NuxtLink
          v-else
          :to="`/inbox/${item.id}`"
          class="flex gap-3 border-b border-default px-4 py-3 active:bg-elevated"
        >
          <span
            v-if="item.type === 'release_notes' && item.unread"
            class="mt-2 size-2 shrink-0 rounded-full bg-primary"
            aria-label="Unread"
          />
          <AgentAvatar
            :name="item.sender.name"
            size="md"
          />
          <span class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="flex items-center gap-2">
              <span class="font-semibold text-highlighted">{{ item.sender.name }}</span>
              <span class="ms-auto shrink-0 text-xs text-muted">{{ timeAgo(item.at) }}</span>
            </span>
            <span class="font-semibold text-highlighted">{{ item.subject }}</span>
            <span class="line-clamp-2 text-sm text-muted">{{ markdownToPlainText(item.preview) }}</span>
            <span
              v-if="item.type === 'release_notes'"
              class="font-mono text-xs text-muted"
            >{{ item.fromSha ? `${item.fromSha}…` : '' }}{{ item.toSha }}</span>
            <span class="mt-0.5 flex items-center gap-2">
              <UBadge
                :label="typeBadge(item.type).label"
                :color="typeBadge(item.type).color"
                variant="subtle"
                size="sm"
              />
              <span class="flex min-w-0 items-center gap-1 truncate text-xs text-muted">
                <ProjectThumbnail
                  :project="item.project"
                  :size="16"
                />{{ item.project.name }} · {{ item.taskRef }}
              </span>
            </span>
          </span>
        </NuxtLink>
      </li>
      <li
        v-if="listed.length === 0"
        class="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted"
      >
        <UIcon
          name="i-lucide-circle-check"
          class="size-8 text-success"
        />
        All clear. Nothing here right now.
      </li>
      <li
        v-else-if="tab === 'needsYou'"
        class="p-6 text-center text-sm text-muted"
      >
        That's everything in your Inbox.
      </li>
    </ul>
  </div>
</template>
