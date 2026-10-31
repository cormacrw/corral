<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { taskBlockers } from '~/utils/taskBlockers'
import { STATUS } from '~/utils/labels'

const props = defineProps<{ task: Task, tasks: Task[] }>()
const blockers = computed(() => taskBlockers(props.task, props.tasks))
const open = ref(false)
const flyout = useTaskFlyout()
function openTask(ref: string) {
  open.value = false
  flyout.open(ref)
}
</script>

<template>
  <UPopover
    v-if="blockers.tasks.length || blockers.epics.length"
    v-model:open="open"
    :content="{ side: 'top', align: 'end', collisionPadding: 12 }"
  >
    <button
      type="button"
      :aria-label="`What ${task.ref} is waiting on`"
      class="flex size-6 cursor-pointer items-center justify-center rounded text-warning focus-visible:outline-2 focus-visible:outline-primary"
      @click.stop
    >
      <UIcon
        name="i-lucide-ban"
        class="size-4"
      />
    </button>
    <template #content>
      <div
        class="w-64 max-w-[calc(100vw-24px)] p-2"
        @click.stop
      >
        <h3 class="px-2 py-1 text-xs font-medium text-muted">
          Waiting on
        </h3>
        <ul class="max-h-[60vh] overflow-y-auto">
          <li
            v-for="blocker in blockers.tasks"
            :key="blocker.id"
          >
            <button
              type="button"
              class="flex w-full cursor-pointer flex-col gap-1 rounded p-2 text-start text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
              @click="openTask(blocker.ref)"
            >
              <span class="wrap-anywhere text-highlighted">{{ blocker.title }}</span>
              <span class="flex flex-wrap gap-2 text-xs text-muted">
                <span>{{ blocker.ref }}</span>
                <span>{{ STATUS[blocker.status].label }}</span>
              </span>
            </button>
          </li>
          <li
            v-for="epic in blockers.epics"
            :key="epic.id"
          >
            <NuxtLink
              :to="`/epics/${epic.id}`"
              class="flex flex-col gap-1 rounded p-2 text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
              @click="open = false"
            >
              <span class="wrap-anywhere text-highlighted">{{ epic.title }}</span>
              <span class="text-xs text-muted">Epic</span>
            </NuxtLink>
          </li>
        </ul>
      </div>
    </template>
  </UPopover>
</template>
