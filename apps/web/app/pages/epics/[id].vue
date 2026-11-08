<script setup lang="ts">
import { SECTIONS, taskPath } from '~/utils/routes'
import { useQuery } from '@tanstack/vue-query'
import { epicQuery } from '~/queries/epics'

// An empty delivery record with no parent task; anything else moves to its task
definePageMeta({ taskFlyout: true })

const route = useRoute()
const id = computed(() => String(route.params.id))
const device = useDevice()
// A shared link has nothing to go back to
const router = useRouter()
const back = () => window.history.state?.back ? router.back() : navigateTo(SECTIONS.projects.to)
useSeoMeta({ title: 'Task · Corral' })

// Old links open the parent task, or the task itself for a collapsed epic (D31)
const { data: epic } = useQuery(computed(() => epicQuery(id.value)))
const target = computed(() => epic.value ? epic.value.taskRef ?? epic.value.tasks[0]?.ref ?? null : null)
watch(target, (ref) => {
  if (ref) void navigateTo(taskPath(ref), { replace: true })
}, { immediate: true })
</script>

<template>
  <AppPanel>
    <main
      v-if="device.isMobile.value"
      class="flex h-full min-h-0 flex-col"
    >
      <EpicDetail
        :epic-id="id"
        mode="mobile"
        @close="back"
      />
    </main>
    <div
      v-else
      class="flex h-full min-h-0"
    >
      <main class="flex min-w-0 flex-1 flex-col">
        <EpicDetail
          :epic-id="id"
          mode="page"
        />
      </main>
    </div>
  </AppPanel>
</template>
