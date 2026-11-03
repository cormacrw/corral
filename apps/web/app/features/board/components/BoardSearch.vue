<script setup lang="ts">
// The web Board's search (design/board.md): an icon that opens the search bar.
// Closing it clears the search. A search from the URL starts it open.
const search = defineModel<string>({ required: true })

const open = ref(Boolean(search.value))
const showing = computed(() => open.value || Boolean(search.value))

function setOpen(next: boolean) {
  open.value = next
  if (!next) search.value = ''
}
</script>

<template>
  <AppInput
    v-if="showing"
    v-model="search"
    placeholder="Search tasks"
    aria-label="Search tasks"
    icon="i-hugeicons-search-01"
    size="sm"
    autofocus
    class="w-60"
    @keydown.esc="setOpen(false)"
  />
  <AppButton
    :icon="showing ? 'i-hugeicons-cancel-01' : 'i-hugeicons-search-01'"
    size="sm"
    variant="ghost"
    color="neutral"
    :aria-label="showing ? 'Close search' : 'Search tasks'"
    :aria-pressed="showing"
    @click="setOpen(!showing)"
  />
</template>
