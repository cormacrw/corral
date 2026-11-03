<script setup lang="ts">
import type { EpicDetail, Project } from '@corral/contracts'
import { epicHistoryText } from '~/utils/labels'
import type { useEpicDetail } from '~/features/epics/composables/useEpicDetail'
import EpicParentBar from '~/features/epics/components/EpicParentBar.vue'
import EpicTaskList from '~/features/epics/components/EpicTaskList.vue'

// An epic's work, in tabs: its tasks as a list or a dependency graph, the
// activity feed and the parent's comments.
type Detail = ReturnType<typeof useEpicDetail>
const props = defineProps<{
  epic: EpicDetail
  project: Project | null
  parent: Detail['parent']['value']
  activity: Detail['activity']['value']
  activityFailed: boolean
  retryActivity: () => unknown
  mode: 'flyout' | 'page' | 'mobile'
}>()
defineEmits<{ deleted: [] }>()

const flyout = useTaskFlyout()
const tab = useLocalStorage<'tasks' | 'graph' | 'activity' | 'comments'>('corral.epic.tab', 'tasks')
// A phone has room for all four labels only without their icons
const TAB_ICONS: Record<string, string> = { tasks: 'i-ri-list-unordered', graph: 'i-ri-node-tree', activity: 'i-ri-pulse-line', comments: 'i-ri-message-2-line' }
const tabs = computed(() => [
  { label: `Sub-tasks (${props.epic.tasks.length})`, value: 'tasks' },
  { label: 'Graph', value: 'graph' },
  { label: 'Activity', value: 'activity' },
  ...props.epic.taskId && props.epic.taskRef ? [{ label: 'Comments', value: 'comments' }] : []
].map(item => ({ ...item, icon: props.mode === 'mobile' ? undefined : TAB_ICONS[item.value] })))

// Mobile has no flyout, so a task opens as its own page
const openTask = (ref: string) => props.mode === 'mobile' ? navigateTo(`/tasks/${ref}`) : flyout.open(ref)
</script>

<template>
  <!-- In a stacked column the tasks follow the details in the one scroll,
       so the list never shrinks into a scroll of its own -->
  <section :class="['flex min-w-0 flex-col', mode === 'page' ? 'min-h-0 flex-1 max-[900px]:h-[560px]' : 'shrink-0 px-4 pb-4']">
    <EpicParentBar
      v-if="parent"
      :parent="parent"
      :empty="epic.tasks.length === 0"
      :merged="!!epic.mergedAt"
      :class="mode === 'page' && 'px-4 pt-3'"
      @deleted="$emit('deleted')"
    />
    <AppTabs
      v-model="tab"
      :items="tabs"
      :variant="mode === 'mobile' ? 'pill' : 'link'"
      :content="false"
      :trigger-class="mode === 'mobile' && 'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs'"
      :class="mode === 'page' && 'px-4 pt-2'"
    />
    <div
      v-if="tab === 'comments'"
      class="min-h-0 overflow-y-auto"
    >
      <ParentComments
        v-if="epic.taskId && epic.taskRef && project"
        :slug="project.slug"
        :task-id="epic.taskId"
        :task-ref="epic.taskRef"
      />
    </div>
    <div
      v-else-if="tab === 'activity'"
      class="flex min-h-0 flex-col gap-3 overflow-y-auto p-4"
    >
      <AuditActivity
        v-for="entry in activity"
        :key="entry.id"
        :entry="entry"
        :text="epicHistoryText(entry)"
      />
      <AppLoadError
        v-if="activityFailed"
        title="Couldn't load the activity."
        :retry="retryActivity"
      />
      <p
        v-else-if="!activity.length"
        class="text-sm text-muted-foreground"
      >
        No activity yet.
      </p>
    </div>
    <p
      v-else-if="epic.tasks.length === 0"
      class="p-6 text-center text-sm text-muted-foreground"
    >
      No tasks in this parent yet.
    </p>
    <EpicTaskList
      v-else-if="tab === 'tasks'"
      :tasks="epic.tasks"
      :selected="flyout.ref.value"
      :roomy="mode === 'mobile'"
      :class="mode === 'page' ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2' : 'mt-2'"
      @open="openTask"
    />
    <div
      v-else
      :aria-label="`Dependency graph of ${epic.title}`"
      :class="mode === 'page' ? 'min-h-0 flex-1' : 'mt-2 h-[420px] overflow-hidden rounded-lg border border-border'"
    >
      <AsyncEpicGraph
        :tasks="epic.tasks"
        :selected="flyout.ref.value"
        :minimap="mode === 'page'"
        :direction="mode === 'page' ? 'right' : 'down'"
        @open="openTask($event)"
      />
    </div>
  </section>
</template>
