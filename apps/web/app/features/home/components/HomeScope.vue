<script setup lang="ts">
// What Home is showing: the runner's state, and all projects or just one
const props = defineProps<{ runner: { online: boolean, label: string }, items: { label: string, value: string }[] }>()
const projectId = defineModel<string>({ required: true })
const menu = computed(() => props.items.map(item => ({
  label: item.label,
  onSelect: () => {
    projectId.value = item.value
  }
})))
const selected = computed(() => props.items.find(item => item.value === projectId.value)?.label ?? 'All projects')
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
    <span
      :class="['size-2 rounded-full', runner.online ? 'bg-success' : 'bg-destructive']"
      aria-hidden="true"
    />
    {{ runner.label }} ·
    <AppDropdownMenu :items="menu">
      <AppButton
        :label="selected"
        trailing-icon="i-hugeicons-arrow-down-01"
        variant="link"
        color="neutral"
        size="sm"
        class="p-0 text-sm text-muted-foreground"
        aria-label="Project"
        data-testid="home-project"
      />
    </AppDropdownMenu>
    · Today
  </div>
</template>
