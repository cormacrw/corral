<script setup lang="ts">
import { useEpicDetail } from '~/features/epics/composables/useEpicDetail'
import DetailHeader from '~/features/tasks/components/DetailHeader.vue'
import EpicDependencies from '~/features/epics/components/EpicDependencies.vue'
import EpicDescription from '~/features/epics/components/EpicDescription.vue'
import EpicDetailTitle from '~/features/epics/components/EpicDetailTitle.vue'
import EpicHistory from '~/features/epics/components/EpicHistory.vue'
import EpicProgress from '~/features/epics/components/EpicProgress.vue'
import EpicReviewSettings from '~/features/epics/components/EpicReviewSettings.vue'
import EpicSyncAlerts from '~/features/epics/components/EpicSyncAlerts.vue'
import EpicWork from '~/features/epics/components/EpicWork.vue'

// An epic: its title, description and progress, and the dependency tree of
// its tasks. Docked in the flyout, as a page with room for a big tree, or
// as the mobile screen, where tasks open as pages (design/mobile.md).
const props = defineProps<{ epicId: string, mode: 'flyout' | 'page' | 'mobile' }>()
const emit = defineEmits<{ close: [] }>()
const { epicResult, activityResult, epic, error, project, parent, activity, prerequisites, blockedEpics, waiting, choices, saved, patch } = useEpicDetail(() => props.epicId)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DetailHeader
      :mode="mode"
      :path="epic?.taskRef ? `/tasks/${epic.taskRef}` : `/epics/${epicId}`"
      :saved="saved"
      @close="emit('close')"
    >
      <EpicDetailTitle
        :mode="mode"
        :epic="epic"
        :project="project"
        :saved="saved"
      />
    </DetailHeader>

    <AppLoadError
      v-if="error"
      :title="error"
      class="m-4"
      :retry="() => epicResult.refetch()"
    />
    <div
      v-else-if="!epic"
      class="flex flex-col gap-3 p-4"
    >
      <UiSkeleton class="h-6 w-2/3" />
      <UiSkeleton class="h-16 w-full" />
      <UiSkeleton class="h-64 w-full" />
    </div>

    <div
      v-else
      :class="['flex min-h-0 flex-1', mode === 'page' ? 'max-[900px]:flex-col' : 'flex-col overflow-y-auto overscroll-contain']"
    >
      <div :class="['flex flex-col gap-5 p-4', mode === 'page' && 'w-[360px] shrink-0 overflow-y-auto overscroll-contain border-e border-border max-[900px]:w-full max-[900px]:border-e-0']">
        <EpicSyncAlerts
          :epic-id="epicId"
          :waiting="waiting"
          :sync="epic.sync ?? null"
        />
        <input
          :value="epic.title"
          class="w-full rounded-md bg-transparent px-1 py-0.5 text-lg font-semibold text-foreground hover:bg-muted focus:ring-2 focus:ring-primary focus:outline-none"
          aria-label="Parent title"
          @change="patch({ title: ($event.target as HTMLInputElement).value })"
        >
        <EpicFixRuns
          v-if="epic.fixes?.length"
          :runs="epic.fixes"
        />
        <EpicHistory :epic-id="epicId" />
        <!-- Keyed: an edit in progress doesn't follow to the next epic -->
        <EpicDescription
          :key="epic.id"
          :description="epic.description"
          :save="description => patch({ description })"
        />
        <EpicReviewSettings
          :epic="epic"
          @change="patch({ reviewMode: $event })"
        />
        <EpicDependencies
          :key="epic.id"
          :epic-id="epic.id"
          :depends-on="epic.dependsOn"
          :prerequisites="prerequisites"
          :blocked="blockedEpics"
          :choices="choices"
        />
        <EpicProgress :epic="epic" />
      </div>

      <EpicWork
        :epic="epic"
        :project="project"
        :parent="parent"
        :activity="activity"
        :activity-failed="activityResult.isLoadingError.value"
        :retry-activity="() => activityResult.refetch()"
        :mode="mode"
        @deleted="emit('close')"
      />
    </div>
  </div>
</template>
