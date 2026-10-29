<script setup lang="ts">
// The task page (design/task.md, page mode). On mobile it's the full-page
// task screen instead (design/mobile.md)
const route = useRoute()
const ref = computed(() => String(route.params.ref).toUpperCase())
const device = useDevice()
// A shared link has nothing to go back to
const router = useRouter()
const back = () => window.history.state?.back ? router.back() : navigateTo('/projects')
useSeoMeta({ title: () => `${ref.value} · Corral` })
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <main class="flex h-full min-h-0 flex-col">
      <TaskDetail
        :task-ref="ref"
        :mode="device.isMobile.value ? 'mobile' : 'page'"
        @close="back"
      />
    </main>
  </UDashboardPanel>
</template>
