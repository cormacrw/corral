<script setup lang="ts">
// An epic with room for its dependency tree; tasks open in the flyout. On
// mobile it's the epic screen, and tasks open as pages (design/mobile.md)
const route = useRoute()
const id = computed(() => String(route.params.id))
const device = useDevice()
// A shared link has nothing to go back to
const router = useRouter()
const back = () => window.history.state?.back ? router.back() : navigateTo('/projects')
useSeoMeta({ title: 'Epic · Corral' })
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
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
      <TaskFlyout />
    </div>
  </UDashboardPanel>
</template>
