<script setup lang="ts">
const { project } = useProject()
useSeoMeta({ title: () => `Backlog · ${project.value?.name ?? ''} · Corral` })
const device = useDevice()
const backlog = useBacklog()
const { confirmOpen, confirmEpic, confirmMove } = backlog
</script>

<template>
  <AppPanel>
    <BacklogMobile
      v-if="device.isMobile.value"
      :backlog="backlog"
    />
    <BacklogDesktop
      v-else
      :backlog="backlog"
    />
    <AppModal
      v-model:open="confirmOpen"
      :title="`Move ${confirmEpic?.tasks.length} tasks to the board?`"
      :description="`Every Backlog task in ${confirmEpic?.title} becomes Ready, and agents start on them in dependency order. Tasks missing a description or acceptance criteria stay in the Backlog.`"
    >
      <template #footer>
        <AppButton
          label="Cancel"
          variant="outline"
          color="neutral"
          @click="confirmOpen = false"
        />
        <AppButton
          label="Move to board"
          icon="i-ri-kanban-view"
          @click="confirmMove"
        />
      </template>
    </AppModal>
  </AppPanel>
</template>
