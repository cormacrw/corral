<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTaskActions } from '~/features/tasks/composables/useTaskActions'
import { useTaskCommentDraft } from '~/features/tasks/composables/useTaskCommentDraft'
import { useTaskDetail } from '~/features/tasks/composables/useTaskDetail'
import { agentHolds, canAddSubtask, workerRole } from '~/features/tasks/utils/taskDetail'

// One TaskDetail with three modes (design/task.md): docked flyout, the
// task page with a properties rail, or the full mobile page with Details
// and Criteria and activity tabs (design/mobile.md)
const props = defineProps<{ taskRef: string, mode: 'flyout' | 'page' | 'mobile' }>()
const emit = defineEmits<{ close: [] }>()

const detail = useTaskDetail(() => props.taskRef)
const { task, project, slug, epic, delivery, projectTasks, pending, error, retry, comments, history, evidence, reviews, runs } = detail
const { saved, resuming, placing, confirmDelete, removing, fail, patch, changeStatus, resume, place, remove } = useTaskActions(detail, () => emit('close'))
const { draft, send } = useTaskCommentDraft(detail, fail)

const route = useRoute()
// Mobile splits the body in two; evidence lives with criteria and activity
const mobileTab = ref<'details' | 'criteria'>(route.query.evidence ? 'criteria' : 'details')
watch(() => props.taskRef, () => {
  mobileTab.value = route.query.evidence ? 'criteria' : 'details'
})
const mobile = computed(() => props.mode === 'mobile')
// Every part shows in the flyout and page; mobile shows one tab's parts
const shows = (part: 'details' | 'criteria') => !mobile.value || mobileTab.value === part

const isDraft = computed(() => task.value?.status === 'draft')
// Merged is final (D10): the task reads as it shipped; only comments change
const readonly = computed(() => task.value?.status === 'merged')
const bodyClass = computed(() => props.mode === 'page'
  ? 'mx-auto grid w-full max-w-[1200px] gap-8 p-6 max-[900px]:grid-cols-1 min-[900px]:grid-cols-[1fr_260px]'
  : mobile.value ? 'pt-4 pb-[env(safe-area-inset-bottom)]' : 'p-4')
const propertiesClass = computed(() => mobile.value
  ? 'mx-0! -mt-2 border-y border-border px-4 [&>*]:min-h-11 [&>*:not(:nth-last-child(-n+2))]:border-b [&>*]:border-border'
  : 'gap-x-4 gap-y-1')
const mobileTabs = computed(() => [{ label: 'Details', value: 'details' }, { label: isDraft.value ? 'Criteria' : 'Criteria and activity', value: 'criteria' }])

const worker = computed(() => task.value?.developer?.name ?? null)
const fallbackWorker = computed(() => task.value ? workerRole(task.value) : 'developer')
const sentTo = computed(() => task.value && agentHolds(task.value) && task.value.lease ? worker.value ?? `the ${fallbackWorker.value}` : null)
const composerHint = computed(() => task.value && agentHolds(task.value)
  ? `${worker.value ?? `The ${fallbackWorker.value}`} gets this on its next step.`
  : 'No agent is working on this task, so this is saved as a note.')
</script>

<template>
  <!-- A parent's page is its delivery page with its comments (D31) -->
  <EpicDetail
    v-if="task?.rollup"
    :epic-id="task.rollup.epicId"
    :mode="props.mode"
    @close="emit('close')"
  />
  <div
    v-else
    class="flex h-full min-h-0 flex-col"
  >
    <TaskDetailHeader
      :task="task"
      :task-ref="props.taskRef"
      :mode="props.mode"
      :project="project"
      :epic="epic"
      :saved="saved"
      @close="emit('close')"
      @delete="confirmDelete = true"
    />

    <DetailLoading v-if="pending" />
    <AppLoadError
      v-else-if="error"
      :title="error"
      :retry="retry"
      class="m-4"
    />

    <div
      v-else-if="task"
      :class="['min-h-0 flex-1 overflow-y-auto overscroll-contain', bodyClass]"
    >
      <div :class="['flex min-w-0 flex-col gap-5', mobile && '*:mx-4']">
        <h2
          v-if="readonly"
          class="px-1 py-0.5 text-lg font-semibold text-foreground"
        >
          {{ task.title }}
        </h2>
        <input
          v-else
          :value="task.title"
          class="self-stretch rounded-md bg-transparent px-1 py-0.5 text-lg font-semibold text-foreground hover:bg-muted focus:ring-2 focus:ring-primary focus:outline-none"
          aria-label="Title"
          @change="patch({ title: ($event.target as HTMLInputElement).value })"
        >

        <TaskStatusNotices
          :task="task"
          :mobile="mobile"
          :resuming="resuming"
          @resume="resume"
        />

        <template v-if="mobile">
          <TaskWorkingBanner :task="task" />
          <AppTabs
            v-model="mobileTab"
            :items="mobileTabs"
            :content="false"
            class="-mt-2"
          />
        </template>

        <TaskStageNotice
          v-if="shows('details')"
          :task="task"
          :placing="placing"
          @place="place"
        />
        <AddSubtask
          v-if="canAddSubtask(task, runs) && shows('details')"
          :slug="slug"
          :number="task.number"
          promotes
        />
        <TaskDelivery
          v-if="delivery && shows('details')"
          :epic="delivery"
        />

        <dl
          v-if="props.mode === 'flyout' || (mobile && shows('details'))"
          :class="['grid grid-cols-[112px_1fr] text-sm', propertiesClass]"
        >
          <TaskProperties
            :task="task"
            :project="project"
            @status="changeStatus"
            @patch="patch"
          />
        </dl>

        <DesignReview
          v-if="task.type === 'design' && !isDraft && shows('details')"
          :key="task.id"
          :task="task"
          :slug="slug"
          :mobile="mobile"
        />

        <TaskDependencies
          v-if="shows('details')"
          :task="task"
          :project-tasks="projectTasks"
          :readonly="readonly"
          @patch="patch"
        />

        <!-- These hold edits in progress: v-show keeps them across the mobile
             tabs, and the key resets them on switching to another task -->
        <TaskDescriptionField
          v-show="shows('details')"
          :key="props.taskRef"
          :task="task"
          :slug="slug"
          :readonly="readonly"
          :sent-to="sentTo"
          :save="patch"
        />
        <TaskImplementationPlanField
          v-show="shows('details')"
          :key="props.taskRef"
          :task="task"
          :slug="slug"
          :readonly="readonly"
          :save="patch"
        />
        <TaskCriteria
          v-show="shows('criteria')"
          :key="props.taskRef"
          :task="task"
          :epic="epic"
          :readonly="readonly"
          :save="patch"
        />
        <TaskActivity
          v-if="!isDraft"
          v-show="shows('criteria')"
          :key="props.taskRef"
          :task="task"
          :task-ref="props.taskRef"
          :slug="slug"
          :comments="comments"
          :history="history"
          :runs="runs"
          :evidence="evidence"
          :reviews="reviews"
          :draft="draft"
          :hint="composerHint"
          :send="send"
        />

        <TaskDeleteSection
          v-if="task.status !== 'merged'"
          v-model:open="confirmDelete"
          :task="task"
          :mobile="mobile"
          :removing="removing"
          @remove="remove"
        />
      </div>

      <dl
        v-if="props.mode === 'page'"
        class="flex flex-col gap-3 text-sm"
      >
        <TaskProperties
          :task="task"
          :project="project"
          stacked
          @status="changeStatus"
          @patch="patch"
        />
      </dl>
    </div>
  </div>
</template>
