<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { taskBlockers } from '~/features/tasks/utils/taskBlockers'
import { STATUS } from '~/utils/labels'

const props = defineProps<{ task: Task, tasks: Task[] }>()
const blockers = computed(() => taskBlockers(props.task, props.tasks))
const hasBlockers = computed(() => blockers.value.tasks.length > 0 || blockers.value.unlisted.length > 0 || blockers.value.epics.length > 0)
const open = ref(false)
watch(hasBlockers, (value) => {
  if (!value) open.value = false
})
const flyout = useTaskFlyout()
const rowClass = 'rounded px-2 py-1.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary'
function openTask(ref: string) {
  open.value = false
  flyout.open(ref)
}
</script>

<template>
  <AppPopover
    v-if="hasBlockers"
    v-model:open="open"
    :content="{ side: 'top', align: 'end', collisionPadding: 12 }"
  >
    <button
      type="button"
      :aria-label="`What ${task.ref} is waiting on`"
      class="flex size-6 cursor-pointer items-center justify-center rounded text-warning hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
      @click.stop
    >
      <Icon
        name="i-hugeicons-unavailable"
        class="size-4"
      />
    </button>
    <template #content>
      <div
        class="w-64 max-w-[calc(100vw-24px)] p-1"
        @click.stop
      >
        <h3 class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          Waiting on
        </h3>
        <ul class="max-h-[60vh] overflow-y-auto">
          <li
            v-for="blocker in blockers.tasks"
            :key="blocker.id"
          >
            <button
              type="button"
              :class="['flex w-full cursor-pointer flex-col gap-0.5 text-start', rowClass]"
              @click="openTask(blocker.ref)"
            >
              <span class="wrap-anywhere font-medium text-foreground">{{ blocker.title }}</span>
              <span class="text-xs text-muted-foreground">{{ blocker.ref }} · {{ STATUS[blocker.status].label }}</span>
            </button>
          </li>
          <li
            v-for="blockerRef in blockers.unlisted"
            :key="blockerRef"
          >
            <button
              type="button"
              :class="['flex w-full cursor-pointer text-start font-medium text-foreground', rowClass]"
              @click="openTask(blockerRef)"
            >
              {{ blockerRef }}
            </button>
          </li>
          <li
            v-for="epic in blockers.epics"
            :key="epic.id"
          >
            <NuxtLink
              :to="`/epics/${epic.id}`"
              :class="['flex flex-col gap-0.5', rowClass]"
              @click="open = false"
            >
              <span class="wrap-anywhere font-medium text-foreground">{{ epic.title }}</span>
              <span class="text-xs text-muted-foreground">Parent</span>
            </NuxtLink>
          </li>
        </ul>
      </div>
    </template>
  </AppPopover>
</template>
