<script setup lang="ts">
// An epic with room for its dependency tree; tasks open in the flyout
const route = useRoute()
const id = computed(() => String(route.params.id))
useSeoMeta({ title: 'Epic · Corral' })
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <div class="flex h-full min-h-0">
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
