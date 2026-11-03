<script setup lang="ts">
import type { Agent, Epic } from '@corral/contracts'
import { EPIC_CONFLICT_PENDING, EPIC_FIX, epicStoppedLabel, runPath } from '~/utils/labels'
import { markdownToPlainText } from '~/utils/markdown'

// An epic on the Board: its title and progress, with a blocked icon while
// prerequisite epics are unfinished (COR-154). The card is a div so the icon
// can be a real button; the title button is the keyboard way in, and its click
// bubbles to the card. Everything else stays in the epic flyout.
const props = defineProps<{ epic: Epic, waitingOn: Epic[], workingAgents: Agent[] }>()
const flyout = useTaskFlyout()
const selected = computed(() => flyout.epic.value === props.epic.id)
const popover = ref(false)
const summary = computed(() => props.epic.description ? markdownToPlainText(props.epic.description) : '')

function openPrerequisite(id: string) {
  popover.value = false
  flyout.openEpic(id)
}
</script>

<template>
  <BorderGlow
    :active="workingAgents.length > 0"
    :glow-radius="8"
    class="shrink-0"
  >
    <div
      :data-epic-card="epic.id"
      :class="[
        'flex w-full shrink-0 cursor-pointer flex-col gap-2 rounded-md border bg-background p-3 text-sm hover:border-input has-[[data-card]:focus-visible]:outline-2 has-[[data-card]:focus-visible]:outline-primary',
        selected ? 'border-primary ring-1 ring-primary' : workingAgents.length ? 'border-primary/60' : 'border-border'
      ]"
      @click="flyout.toggleEpic(epic.id)"
    >
      <span class="flex min-w-0 items-start gap-2">
        <button
          type="button"
          data-card
          :aria-pressed="selected"
          class="min-w-0 flex-1 cursor-pointer break-words text-start font-medium text-foreground outline-none"
        >
          {{ epic.title }}
        </button>
        <span
          v-if="waitingOn.length"
          class="flex shrink-0"
          @click.stop
        >
          <AppPopover
            v-model:open="popover"
            :content="{ side: 'top', align: 'end' }"
          >
            <button
              type="button"
              :aria-label="`Waiting on ${waitingOn.length} ${waitingOn.length === 1 ? 'parent' : 'parent tasks'}`"
              class="flex size-5 cursor-pointer items-center justify-center rounded text-warning hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
            >
              <Icon
                name="i-hugeicons-unavailable"
                class="size-4"
              />
            </button>
            <template #content>
              <div
                data-blockers
                class="w-64 max-w-[calc(100vw-2rem)] p-1"
              >
                <p class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  Waiting on
                </p>
                <button
                  v-for="prerequisite in waitingOn"
                  :key="prerequisite.id"
                  type="button"
                  class="flex w-full min-w-0 flex-col gap-0.5 rounded px-2 py-1.5 text-start text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
                  @click="openPrerequisite(prerequisite.id)"
                >
                  <span class="truncate font-medium text-foreground">{{ prerequisite.title }}</span>
                  <span class="text-xs text-muted-foreground">{{ prerequisite.mergedCount }} of {{ prerequisite.taskCount }} merged</span>
                </button>
              </div>
            </template>
          </AppPopover>
        </span>
      </span>
      <p
        v-if="summary"
        class="line-clamp-2 min-w-0 text-xs break-words text-muted-foreground"
        data-testid="epic-card-summary"
      >
        {{ summary }}
      </p>
      <TaskCardMeta
        :task-ref="epic.taskRef"
        :pr-number="epic.prNumber"
        :at="epic.updatedAt"
      />
      <div
        role="meter"
        :aria-label="`${epic.title}: ${epic.mergedCount} of ${epic.taskCount} tasks merged`"
        :aria-valuenow="epic.mergedCount"
        aria-valuemin="0"
        :aria-valuemax="epic.taskCount"
        class="flex h-1.5 gap-0.5"
      >
        <span
          class="rounded-full bg-primary"
          :style="{ flex: epic.mergedCount }"
        />
        <span
          class="rounded-full bg-input"
          :style="{ flex: epic.taskCount - epic.mergedCount }"
        />
      </div>
      <div
        v-if="epic.sync?.state === 'fixing'"
        class="min-w-0 text-xs"
        data-testid="epic-card-fix"
      >
        <p class="font-medium text-info">
          {{ EPIC_FIX[epic.sync.fix].active }}
        </p>
        <NuxtLink
          v-if="epic.sync.developer"
          :to="runPath(epic.sync.developer.name, epic.sync.developer.runId)"
          class="font-medium text-brand hover:underline"
          @click.stop
        >
          {{ epic.sync.developer.name }}
        </NuxtLink>
        <span
          v-else
          class="text-muted-foreground"
        >Waiting for a developer</span>
        <p class="mt-0.5 line-clamp-2 break-words text-muted-foreground">
          {{ epic.sync.reason }}
        </p>
      </div>
      <div
        v-else-if="epic.sync?.state === 'failed'"
        class="min-w-0 text-xs"
        data-testid="epic-card-stopped"
      >
        <p class="font-medium text-destructive">
          {{ epicStoppedLabel(epic.sync.fix) }}
        </p>
        <p class="mt-0.5 line-clamp-2 break-words text-muted-foreground">
          {{ epic.sync.error }}
        </p>
      </div>
      <p
        v-else-if="epic.sync?.state === 'conflict_pending'"
        class="min-w-0 break-words text-xs text-muted-foreground"
        data-testid="epic-card-conflict-pending"
      >
        {{ EPIC_CONFLICT_PENDING }}
      </p>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-muted-foreground">{{ epic.mergedCount }} of {{ epic.taskCount }} merged</span>
        <div
          v-if="workingAgents.length"
          role="group"
          :aria-label="`Agents working on ${epic.title}: ${workingAgents.map(agent => agent.name).join(', ')}`"
          class="flex items-center -space-x-2"
        >
          <AppTooltip
            v-for="agent in workingAgents.slice(0, 3)"
            :key="agent.id"
            :text="agent.name"
          >
            <span
              role="img"
              :aria-label="agent.name"
              tabindex="0"
              class="relative flex rounded-full ring-2 ring-border focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary"
              @click.stop
            >
              <AgentAvatar
                :name="agent.name"
                :src="agent.avatarUrl"
                size="xs"
                aria-hidden="true"
              />
            </span>
          </AppTooltip>
          <span
            v-if="workingAgents.length > 3"
            aria-hidden="true"
            class="relative flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-border"
          >+{{ workingAgents.length - 3 }}</span>
        </div>
      </div>
    </div>
  </BorderGlow>
</template>
