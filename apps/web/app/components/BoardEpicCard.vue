<script setup lang="ts">
import type { Agent, Epic } from '@corral/contracts'

// An epic on the Board: its title and progress, with a blocked icon while
// prerequisite epics are unfinished (COR-154). The card is a div so the icon
// can be a real button; the title button is the keyboard way in, and its click
// bubbles to the card. Everything else stays in the epic flyout.
const props = defineProps<{ epic: Epic, waitingOn: Epic[], workingAgents: Agent[] }>()
const flyout = useTaskFlyout()
const selected = computed(() => flyout.epic.value === props.epic.id)
const popover = ref(false)

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
        'flex w-full shrink-0 cursor-pointer flex-col gap-2 rounded-md border bg-default p-3 text-sm hover:border-accented has-[[data-card]:focus-visible]:outline-2 has-[[data-card]:focus-visible]:outline-primary',
        selected ? 'border-primary ring-1 ring-primary' : workingAgents.length ? 'border-primary/60' : 'border-default'
      ]"
      @click="flyout.toggleEpic(epic.id)"
    >
      <span class="flex min-w-0 items-start gap-2">
        <button
          type="button"
          data-card
          :aria-pressed="selected"
          class="min-w-0 flex-1 cursor-pointer break-words text-start font-medium text-highlighted outline-none"
        >
          {{ epic.title }}
        </button>
        <span
          v-if="waitingOn.length"
          class="flex shrink-0"
          @click.stop
        >
          <UPopover
            v-model:open="popover"
            :content="{ side: 'top', align: 'end' }"
          >
            <button
              type="button"
              :aria-label="`Waiting on ${waitingOn.length} ${waitingOn.length === 1 ? 'epic' : 'epics'}`"
              class="flex size-5 cursor-pointer items-center justify-center rounded text-warning hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
            >
              <UIcon
                name="i-lucide-ban"
                class="size-4"
              />
            </button>
            <template #content>
              <div
                data-blockers
                class="w-64 max-w-[calc(100vw-2rem)] p-1"
              >
                <p class="px-2 py-1.5 text-xs font-medium text-muted">
                  Waiting on
                </p>
                <button
                  v-for="prerequisite in waitingOn"
                  :key="prerequisite.id"
                  type="button"
                  class="flex w-full min-w-0 flex-col gap-0.5 rounded px-2 py-1.5 text-start text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
                  @click="openPrerequisite(prerequisite.id)"
                >
                  <span class="truncate font-medium text-highlighted">{{ prerequisite.title }}</span>
                  <span class="text-xs text-muted">{{ prerequisite.mergedCount }} of {{ prerequisite.taskCount }} merged</span>
                </button>
              </div>
            </template>
          </UPopover>
        </span>
      </span>
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
          class="rounded-full bg-accented"
          :style="{ flex: epic.taskCount - epic.mergedCount }"
        />
      </div>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-muted">{{ epic.mergedCount }} of {{ epic.taskCount }} merged</span>
        <div
          v-if="workingAgents.length"
          role="group"
          :aria-label="`Agents working on ${epic.title}: ${workingAgents.map(agent => agent.name).join(', ')}`"
          class="flex items-center -space-x-2"
        >
          <UTooltip
            v-for="agent in workingAgents.slice(0, 3)"
            :key="agent.id"
            :text="agent.name"
          >
            <span
              role="img"
              :aria-label="agent.name"
              tabindex="0"
              class="relative flex rounded-full ring-2 ring-default focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary"
              @click.stop
            >
              <AgentAvatar
                :name="agent.name"
                :src="agent.avatarUrl"
                size="xs"
                aria-hidden="true"
              />
            </span>
          </UTooltip>
          <span
            v-if="workingAgents.length > 3"
            aria-hidden="true"
            class="relative flex size-6 items-center justify-center rounded-full bg-elevated text-xs font-medium text-muted ring-2 ring-default"
          >+{{ workingAgents.length - 3 }}</span>
        </div>
      </div>
    </div>
  </BorderGlow>
</template>
