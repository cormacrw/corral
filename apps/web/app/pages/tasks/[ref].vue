<script setup lang="ts">
// The task page (design/task.md, page mode)
const route = useRoute()
const ref = computed(() => String(route.params.ref).toUpperCase())
useSeoMeta({ title: () => `${ref.value} · Corral` })
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0' }">
    <main class="flex h-full min-h-0 flex-col">
      <TaskDetail
        :task-ref="ref"
        mode="page"
        @close="$router.back()"
      />
    </main>
  </UDashboardPanel>
</template>
