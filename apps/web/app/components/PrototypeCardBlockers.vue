<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { STATUS } from '~/utils/labels'

// The blocked icon and the tasks behind it. It sits in a span that stops the
// click, so opening it doesn't also open the card's flyout.
defineProps<{ blockers: Task[], icon: string }>()
defineEmits<{ open: [ref: string] }>()
const open = ref(false)
</script>

<template>
  <span
    class="flex shrink-0"
    @click.stop
  >
    <UPopover
      v-model:open="open"
      :content="{ side: 'top', align: 'end' }"
    >
      <button
        type="button"
        data-blocked
        :aria-label="`Waiting on ${blockers.length} ${blockers.length === 1 ? 'task' : 'tasks'}`"
        class="flex size-6 items-center justify-center rounded text-warning hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
      >
        <UIcon
          :name="icon"
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
            v-for="blocker in blockers"
            :key="blocker.id"
            type="button"
            class="flex w-full min-w-0 flex-col gap-0.5 rounded px-2 py-1.5 text-start text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
            @click="open = false; $emit('open', blocker.ref)"
          >
            <span class="truncate font-medium text-highlighted">{{ blocker.title }}</span>
            <span class="text-xs text-muted">{{ blocker.ref }} · {{ STATUS[blocker.status].label }}</span>
          </button>
        </div>
      </template>
    </UPopover>
  </span>
</template>
