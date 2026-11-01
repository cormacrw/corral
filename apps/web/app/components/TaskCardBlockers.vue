<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { taskBlockers } from '~/utils/taskBlockers'
import { STATUS } from '~/utils/labels'

const props = defineProps<{ task: Task, tasks: Task[] }>()
const blockers = computed(() => taskBlockers(props.task, props.tasks))
const hasBlockers = computed(() => blockers.value.tasks.length > 0 || blockers.value.epics.length > 0)
const open = ref(false)
watch(hasBlockers, (value) => {
  if (!value) open.value = false
})
const flyout = useTaskFlyout()
function openTask(ref: string) {
  open.value = false
  flyout.open(ref)
}
</script>

<template>
  <UPopover
    v-if="hasBlockers"
    v-model:open="open"
    :content="{ side: 'top', align: 'end', collisionPadding: 12 }"
  >
    <button
      type="button"
      :aria-label="`What ${task.ref} is waiting on`"
      class="flex size-6 cursor-pointer items-center justify-center rounded text-warning hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
      @click.stop
    >
      <UIcon
        name="i-lucide-ban"
        class="size-4"
      />
    </button>
    <template #content>
      <div
        class="w-64 max-w-[calc(100vw-24px)] p-1"
        @click.stop
      >
        <h3 class="px-2 py-1.5 text-xs font-medium text-muted">
          Waiting on
        </h3>
        <ul class="max-h-[60vh] overflow-y-auto">
          <li
            v-for="blocker in blockers.tasks"
            :key="blocker.id"
          >
            <button
              type="button"
              class="flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-start text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              @click="openTask(blocker.ref)"
            >
              <span class="wrap-anywhere font-medium text-highlighted">{{ blocker.title }}</span>
              <span class="text-xs text-muted">{{ blocker.ref }} · {{ STATUS[blocker.status].label }}</span>
            </button>
          </li>
          <li
            v-for="epic in blockers.epics"
            :key="epic.id"
          >
            <NuxtLink
              :to="`/epics/${epic.id}`"
              class="flex flex-col gap-0.5 rounded px-2 py-1.5 text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              @click="open = false"
            >
              <span class="wrap-anywhere font-medium text-highlighted">{{ epic.title }}</span>
              <span class="text-xs text-muted">Epic</span>
            </NuxtLink>
          </li>
        </ul>
      </div>
    </template>
  </UPopover>
</template>
