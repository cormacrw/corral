<script setup lang="ts">
import { taskPath } from '~/utils/routes'
import { searchPages } from '~/features/shell/utils/search'

const open = defineModel<boolean>('open', { default: false })
const shell = useShell()
const lists = useAllProjectLists(() => shell.projects)

// Built while open only: every task event would otherwise flatten every task.
const groups = computed(() => open.value
  ? [
      { id: 'pages', label: 'Go to', items: searchPages(shell.projects, shell.agents) },
      { id: 'tasks', label: 'Tasks', items: Object.values(lists.searchable.value).flatMap(tasks => tasks ?? []).map(t => ({ label: `${t.ref} ${t.title}`, icon: 'i-hugeicons-checkmark-square-02', to: taskPath(t.ref) })) }
    ]
  : [])

function onKeydown(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  open.value = !open.value
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function go(to: string) {
  open.value = false
  void navigateTo(to)
}
</script>

<template>
  <UiCommandDialog
    v-model:open="open"
    title="Search"
    description="Search pages and tasks"
  >
    <UiCommandInput placeholder="Search pages and tasks…" />
    <UiCommandList>
      <UiCommandEmpty>No results</UiCommandEmpty>
      <UiCommandGroup
        v-for="group in groups"
        :key="group.id"
        :heading="group.label"
      >
        <UiCommandItem
          v-for="item in group.items"
          :key="item.to"
          :value="item.label"
          @select="go(item.to)"
        >
          <Icon :name="item.icon" />
          <span class="truncate">{{ item.label }}</span>
        </UiCommandItem>
      </UiCommandGroup>
    </UiCommandList>
  </UiCommandDialog>
</template>
