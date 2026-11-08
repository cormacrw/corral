<script setup lang="ts">
import { epicPath, projectPath, taskPath } from '~/utils/routes'
import type { DetailMode } from '~/composables/useTaskFlyout'
import { computed } from 'vue'
import type { Epic, Project, Task } from '@corral/contracts'
import DetailHeader from '~/components/shared/DetailHeader.vue'

// The task's header: what names it differs by mode (design/task.md)
const props = defineProps<{ task: Task | null, taskRef: string, mode: DetailMode, project: Project | null, epic: Epic | null, saved: boolean }>()
const emit = defineEmits<{ close: [], delete: [] }>()

const flyout = useTaskFlyout()
const isDraft = computed(() => props.task?.status === 'draft')
const parent = computed(() => props.task?.parentTask ? [{ label: props.task.parentTask.title, to: taskPath(props.task.parentTask.ref) }] : [])
const crumbs = computed(() => [{ label: 'Board', to: props.project ? projectPath(props.project.slug, 'board') : '/' }, ...parent.value, { label: props.taskRef }])
const menu = [{ label: 'Delete task', icon: 'i-hugeicons-delete-02', color: 'error' as const, onSelect: () => emit('delete') }]
</script>

<template>
  <DetailHeader
    :mode="mode"
    :path="taskPath(taskRef)"
    :saved="saved"
    @close="emit('close')"
  >
    <nav
      v-if="mode === 'flyout'"
      aria-label="Breadcrumb"
      class="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"
    >
      <template v-if="epic">
        <button
          type="button"
          class="max-w-48 min-w-0 truncate hover:text-foreground hover:underline"
          :title="epic.title"
          @click="flyout.openEpic(epic.id)"
        >
          {{ epic.title }}
        </button>
        <Icon
          name="i-hugeicons-arrow-right-01"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
      </template>
      <span
        class="shrink-0"
        aria-current="page"
      >{{ taskRef }}</span>
    </nav>
    <template v-else-if="mode === 'mobile'">
      <NuxtLink
        v-if="epic"
        :to="epicPath(epic.id)"
        class="block truncate text-xs text-muted-foreground underline"
      >{{ epic.title }} ›</NuxtLink>
      <h1 class="flex items-center gap-2 text-base font-semibold text-foreground">
        {{ taskRef }}
        <AppBadge
          v-if="isDraft"
          label="Draft"
          color="neutral"
          variant="subtle"
          size="sm"
        />
        <span
          v-if="saved"
          class="text-xs font-normal text-success"
        >✓ Saved</span>
      </h1>
    </template>
    <AppBreadcrumb
      v-else
      :items="crumbs"
    />
    <AppBadge
      v-if="isDraft && mode === 'flyout'"
      label="Draft"
      color="neutral"
      variant="subtle"
      size="sm"
      class="shrink-0"
    />
    <template #actions>
      <AppDropdownMenu
        v-if="task && task.status !== 'merged'"
        :items="menu"
        :content="{ align: 'end' }"
      >
        <AppButton
          icon="i-hugeicons-more-horizontal"
          variant="ghost"
          color="neutral"
          aria-label="More"
          class="tap-target"
        />
      </AppDropdownMenu>
    </template>
  </DetailHeader>
</template>
